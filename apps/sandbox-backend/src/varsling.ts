/*
 * Utvalget og jobben bak et utgående varsel.
 *
 * Delt i to med vilje. `finnVarselkandidater` er ren og synkron og svarer på
 * «hvem skal ha dette», så utvalget kan pinnes uten en eneste tjeneste oppe.
 * `kjoerVarsling` er I/O-halvdelen: den fører ledgeren og kaller Fiks.
 *
 * Kanalvalget ligger *ikke* her. Det leses av kontakt- og reservasjonsregisteret,
 * og det registeret er Fiks-siden - `sandbox-backend` får heller ikke importere
 * fra `apps/fiks-simulator` (`pnpm test:imports`). Vi sender varselet og får
 * kanalen i svaret.
 *
 * `scripts/varsle-seniorsirkel.ts` og `POST /api/varsel/seniorsirkel/kjor` er to
 * innganger til denne ene funksjonen, ikke to implementasjoner.
 */
import { alderVed } from "../../shared/alder.ts";
import { readJson, updateJson } from "../../shared/jsonstore.ts";
import type { Varselgrunn, Varselkanal, Varseltype } from "../../shared/varsel.ts";
import { nesteGang, parseAktivitetskatalog } from "../../shared/senioraktivitet.ts";
import type { Neste, Seniortilbud, Tilbud } from "../../shared/senioraktivitet.ts";
import { hentPortalregistreringer } from "./innbyggerportal.ts";
import { maskinportenHeader } from "../../digdir-mock/src/client.ts";
import { fiksBaseUrl, fiksVarselToken, senioraktivitetFil } from "./config.ts";
import { addRevisjon } from "./revisjon.ts";
import { tryUpstream } from "./upstream.ts";
import { evaluateVilkaar } from "./vilkaar.ts";
import type { Ordning, State } from "./types.ts";

/**
 * Hjemmelen for et **uanmodet** varsel, og hvorfor den ikke er samtykke.
 *
 * Innbyggeren har ikke bedt om noe. Hun fyller 62 og bor i kommunen, og så får
 * hun en SMS. Det er behandling av personopplysninger, og grunnlaget kan ikke
 * være samtykke - hun er aldri spurt, og et samtykke vi ikke har innhentet er
 * ikke et samtykke. Samtykket i prosessen `seniorsirkel-profil` gjelder
 * kontaktopplysningene *der*; denne jobben leser kontaktregisteret uten det.
 *
 * Grunnlaget er derfor oppgaven i allmennhetens interesse, og det supplerende
 * rettsgrunnlaget er kommunens egen informasjonsplikt. Den står i loggen på hver
 * kjøring, slik at spørsmålet «hvorfor fikk jeg denne meldingen» har et svar som
 * ikke er «systemet sendte den».
 *
 * **Dette er en sandkasse, og henvisningen bør leses av noen som kan feltet før
 * den brukes som mønster.** Poenget her er formen: et navngitt grunnlag som er
 * noe annet enn samtykke, og som havner i revisjonsloggen.
 */
export const VARSELHJEMMEL = {
  behandlingsgrunnlag: "personvernforordningen artikkel 6 nr. 1 bokstav e",
  suppleringsgrunnlag: "kommuneloven § 4-1 om kommunens informasjonsplikt",
  formaal: "Informere innbyggeren om kommunens seniortilbud"
} as const;

/** Én rad i ledgeren. Nøkkelen er unik, og det er den som gjør jobben idempotent. */
export type Utsending = {
  noekkel: string;
  varseltype: Varseltype;
  personId: string;
  /** Bare paa en paaminnelse eller en avlysning. */
  tilbudId?: string;
  /** Forekomsten, fra `nesteGang`. Se `utsendingsnoekkel`. */
  dato?: string;
  /**
   * `paabegynt` og ikke «reservert»: `reservert` betyr noe annet og juridisk
   * ladet i denne casen - innbyggerens reservasjon mot digital kommunikasjon -
   * og to betydninger av det ordet i samme ledger er en feillesing som venter.
   * `planlagt` finnes bare i en tørrkjøring, der ingen rad er skrevet.
   */
  status: "planlagt" | "paabegynt" | "sendt" | "ikke_naadd" | "feilet";
  kanal?: Varselkanal;
  grunn?: Varselgrunn;
  varselId?: string;
  feil?: string;
  tidspunkt: string;
};

/**
 * Ledgeren, slik den står. Nyeste først.
 *
 * Egen funksjon framfor at ruten leser filen selv: `state/utsendinger.json` har
 * to skrivere, og en tredje leser som kjenner filnavnet er en til å holde i takt.
 */
export async function lesUtsendinger(): Promise<Utsending[]> {
  const rader = (await readJson("utsendinger.json", [])) as Utsending[];
  return rader.slice().sort((a, b) => b.tidspunkt.localeCompare(a.tidspunkt));
}

export type Varselkandidat = {
  personId: string;
  /** Mottakerens digitalId hos Fiks. Slaas opp i KRR der, ikke her. */
  fnr: string;
  varseltype: Varseltype;
  tekst: string;
  tilbudId?: string;
  dato?: string;
};

/**
 * Nøkkelen som avgjør om noen allerede har fått dette.
 *
 * **Datoen er med, og det er hele poenget.** «Ingen får to» betyr «ingen får to
 * for *samme gang*». Et ukentlig tilbud har 52 påminnelser i året, og en nøkkel
 * på `(personId, tilbudId)` alene ville sendt den første og kvalt de 51 andre -
 * i stillhet, som en jobb som ikke fant noe å sende.
 *
 * Et uanmodet varsel har ingen forekomst og skal gå én gang i det hele tatt, så
 * der er `-` det riktige svaret og ikke et hull.
 */
export function utsendingsnoekkel(kandidat: {
  varseltype: Varseltype; personId: string; tilbudId?: string; dato?: string;
}): string {
  return [kandidat.varseltype, kandidat.personId,
    kandidat.tilbudId ?? "-", kandidat.dato ?? "-"].join(":");
}

/**
 * Innbyggerne som skal ha et uanmodet varsel om at tilbudet finnes.
 *
 * Ren og synkron: `evaluateVilkaar` tar tilstanden som parameter, og
 * TJENESTEBEHOV trenger verken inntekt, legeerklæring eller politiattest. Da kan
 * utvalget pinnes mot befolkningen uten en eneste tjeneste oppe.
 *
 * Filteret på utflyttede og døde hører her og ikke i vilkåret: en person som har
 * flyttet ut av landet har fortsatt rett til ordningen på papiret, hun skal bare
 * ikke ha en SMS om den. Importen hardkoder `BOSATT` og `doedsdato: null` i dag,
 * så filteret slår ikke ut på noen - det står her fordi det er her det hører
 * hjemme den dagen dataene får en utflyttet.
 */
export function finnVarselkandidater(
  tilstand: State,
  ordning: Ordning,
  kommunenummer: string,
  tekst: string
): Varselkandidat[] {
  const kandidater: Varselkandidat[] = [];
  for (const person of tilstand.personer as any[]) {
    if (person.bostedsadresse?.kommunenummer !== kommunenummer) continue;
    if (person.personstatus && person.personstatus !== "BOSATT") continue;
    if (person.doedsdato) continue;
    if (!person.foedselsdato || !person.syntetiskFodselsnummer) continue;
    // Alderen regnes av vilkåret; dette er bare en billig forhåndsluking så vi
    // ikke kjører regelen for hele befolkningen i kommunen.
    if (alderVed(person.foedselsdato, tilstand.satser.gjelderFra) < 0) continue;
    const vurdering = evaluateVilkaar(ordning.regel, {
      tilstand,
      personId: person.personId,
      ordning,
      satser: tilstand.satser,
      grunnlag: null,
      legeerklaering: null,
      politiattest: null,
      felles: {},
      forbehold: ""
    } as any);
    if (!vurdering.godkjent) continue;
    kandidater.push({
      personId: person.personId,
      fnr: person.syntetiskFodselsnummer,
      varseltype: "tilbud-finnes",
      tekst
    });
  }
  // Sortert, så to kjøringer av samme data gir samme rekkefølge - og så en
  // tørrkjøring kan sammenlignes med den ekte.
  return kandidater.sort((a, b) => a.personId.localeCompare(b.personId, "nb"));
}

/**
 * Teksten. Deterministisk, og under SMS-grensen med margin.
 *
 * Modellen skriver den ikke i dag, og når den gjør det er lengden fortsatt
 * Fiks-flatens ansvar (`validateVarsellengde`) og ikke promptens: en regel
 * modellen blir bedt om å følge holder mesteparten av tiden, og en som håndheves
 * på sendeflaten holder hver gang.
 */
export function byggVarseltekst(kommunenavn: string): string {
  return `Hei! ${kommunenavn} kommune har aktivitetstilbud for deg over 62 år. `
    + "Se hva som passer for deg på kommunens nettsider.";
}

/**
 * Hjemmelen for et varsel innbyggeren selv har utløst.
 *
 * Et helt annet grunnlag enn `VARSELHJEMMEL`, og det er derfor det står som en
 * egen konstant framfor som en gren i den. Hun har meldt seg på, og bekreftelsen
 * og påminnelsen er en del av den tjenesten - ikke en henvendelse vi tok
 * initiativ til. Skillet er hele grunnen til at varseltypen står i loggen.
 */
export const PAAMELDINGSHJEMMEL = {
  behandlingsgrunnlag: "personvernforordningen artikkel 6 nr. 1 bokstav e",
  suppleringsgrunnlag: "innbyggerens egen påmelding til tilbudet",
  formaal: "Bekrefte og minne om et tilbud innbyggeren har meldt seg på"
} as const;

/** Ukedagen en ISO-dato faller på, på norsk. Til teksten, ikke til regning. */
const UKEDAGSNAVN = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

function ukedagFor(isodato: string): string {
  const [aar, maaned, dag] = isodato.split("-").map(Number);
  return UKEDAGSNAVN[new Date(Date.UTC(aar!, maaned! - 1, dag!)).getUTCDay()]!;
}

/**
 * Teksten i en påminnelse. Under SMS-grensen, og med datoen i klartekst.
 *
 * «tirsdag 15. september kl. 10:00» framfor «2026-09-15T10:00»: det er en melding
 * til et menneske, ikke et felt.
 */
export function byggPaaminnelsestekst(navn: string, neste: Neste): string {
  const [, maaned, dag] = neste.dato.split("-");
  const maaneder = ["januar", "februar", "mars", "april", "mai", "juni", "juli",
    "august", "september", "oktober", "november", "desember"];
  const naar = `${ukedagFor(neste.dato)} ${Number(dag)}. ${maaneder[Number(maaned) - 1]} `
    + `kl. ${neste.fraKlokkeslett}`;
  return `Hei! Påminnelse: ${navn} er ${naar}. Hilsen Ringerike kommune.`;
}

export function byggBekreftelsestekst(navn: string, neste: Neste | null): string {
  if (!neste) return `Hei! Du er påmeldt ${navn}. Hilsen Ringerike kommune.`;
  const [, maaned, dag] = neste.dato.split("-");
  const maaneder = ["januar", "februar", "mars", "april", "mai", "juni", "juli",
    "august", "september", "oktober", "november", "desember"];
  return `Hei! Du er påmeldt ${navn}, ${ukedagFor(neste.dato)} `
    + `${Number(dag)}. ${maaneder[Number(maaned) - 1]} kl. ${neste.fraKlokkeslett}. `
    + "Hilsen Ringerike kommune.";
}

/**
 * Ett varsel, gjennom ledgeren.
 *
 * Samme klemme-før-sending som batchjobben, av samme grunn: to samtidige kall
 * skal ikke kunne se «ikke sendt ennå» begge to. En påmeldingsbekreftelse er den
 * mest sannsynlige av dem alle til å bli dobbeltklikket.
 *
 * Svarer `null` når nøkkelen allerede fantes. Det er ikke en feil - det er
 * ledgeren som gjør jobben sin.
 */
export async function sendEnkeltvarsel(
  kandidat: Varselkandidat,
  valg: { sporingsId: string; hjemmel: typeof VARSELHJEMMEL | typeof PAAMELDINGSHJEMMEL }
): Promise<Utsending | null> {
  const noekkel = utsendingsnoekkel(kandidat);
  const klemt: boolean = await updateJson(
    "utsendinger.json", [], (utsendinger: Utsending[]) => {
      if (utsendinger.some((rad) => rad.noekkel === noekkel)) return false;
      utsendinger.push({
        noekkel,
        varseltype: kandidat.varseltype,
        personId: kandidat.personId,
        ...(kandidat.tilbudId ? { tilbudId: kandidat.tilbudId } : {}),
        ...(kandidat.dato ? { dato: kandidat.dato } : {}),
        status: "paabegynt",
        tidspunkt: new Date().toISOString()
      });
      return true;
    });
  if (!klemt) return null;

  await addRevisjon({
    sporingsId: valg.sporingsId,
    handling: "VARSELUTVALG_UTFOERT",
    ressurs: "varselutvalg",
    formaal: valg.hjemmel.formaal,
    gjaldt: kandidat.personId,
    aktor: { type: "system", id: "sandbox-backend" },
    grunnlag: {
      type: "hjemmel",
      behandlingsgrunnlag: valg.hjemmel.behandlingsgrunnlag,
      suppleringsgrunnlag: valg.hjemmel.suppleringsgrunnlag,
      varseltype: kandidat.varseltype,
      ...(kandidat.tilbudId ? { tilbudId: kandidat.tilbudId } : {})
    }
  });

  const svar = await sendVarsel(kandidat, valg.sporingsId);
  return updateJson("utsendinger.json", [], (rader: Utsending[]) => {
    const rad = rader.find((kandidatrad) => kandidatrad.noekkel === noekkel)!;
    Object.assign(rad, svar.ok
      ? {
        status: svar.data?.kanal === "INGEN" ? "ikke_naadd" : "sendt",
        ...(svar.data?.kanal ? { kanal: svar.data.kanal } : {}),
        ...(svar.data?.grunn ? { grunn: svar.data.grunn } : {}),
        ...(svar.data?.varselId ? { varselId: svar.data.varselId } : {})
      }
      : { status: "feilet", feil: svar.error.message },
      { tidspunkt: new Date().toISOString() });
    return rad;
  });
}

/** Tilbudene som kan minnes om: de som har et tidspunkt å minne om. */
export async function finnArrangementer(fraDato: string): Promise<{
  tilbudId: string; navn: string; aktivitetId: string; neste: Neste | null;
}[]> {
  const katalog = parseAktivitetskatalog(await readJson(senioraktivitetFil));
  return katalog.aktiviteter
    .flatMap((aktivitet) => aktivitet.tilbud.map((tilbud) => ({ aktivitet, tilbud })))
    .filter(({ tilbud }) => tilbud.tidspunkter.length > 0)
    .map(({ aktivitet, tilbud }) => ({
      tilbudId: tilbud.tilbudId,
      aktivitetId: aktivitet.aktivitetId,
      navn: aktivitet.navn,
      neste: nesteGang(tilbud, fraDato)
    }))
    // Sortert på når de går, så nedtrekket leser som en kalender og ikke som en
    // filrekkefølge. De uten neste gang havner sist.
    .sort((a, b) => (a.neste?.dato ?? "9999").localeCompare(b.neste?.dato ?? "9999")
      || a.tilbudId.localeCompare(b.tilbudId, "nb"));
}

export type Paaminnelsesresultat = {
  hjemmel: typeof PAAMELDINGSHJEMMEL;
  tilbudId: string;
  navn: string;
  neste: Neste | null;
  paameldte: number;
  perKanal: Record<string, number>;
  alleredeSendt: number;
  utsendinger: Utsending[];
};

/**
 * Minner alle påmeldte om ett tilbud.
 *
 * `fraDato` er der for demoens skyld: den lar deg simulere at tiden nærmer seg
 * uten å stille klokken. Den er også det som gjør ledgernøkkelen forskjellig fra
 * uke til uke - nøkkelen bærer datoen `nesteGang` kom fram til, så neste ukes
 * påminnelse er en ny rad og ikke en kvalt duplikat.
 *
 * Et tilbud uten neste gang gir ingen påminnelse, og det er et svar: sju av ti
 * tilbud i katalogen hadde ingen `tidspunkter` i det hele tatt før datoene kom.
 */
export async function kjoerPaaminnelse(
  tilstand: State,
  valg: { tilbudId: string; sporingsId: string; fraDato?: string }
): Promise<Paaminnelsesresultat> {
  const fraDato = valg.fraDato || new Date().toISOString().slice(0, 10);
  const arrangementer = await finnArrangementer(fraDato);
  const arrangement = arrangementer.find((rad) => rad.tilbudId === valg.tilbudId);
  if (!arrangement) {
    throw new Error(`Tilbudet ${valg.tilbudId} finnes ikke, eller har ingen tidspunkter.`);
  }

  const paameldte: string[] = [];
  for (const person of tilstand.personer as any[]) {
    const registreringer = await hentPortalregistreringer(person.personId);
    if (registreringer.some((rad) => rad.tilbudId === valg.tilbudId)) {
      paameldte.push(person.personId);
    }
  }

  const perKanal: Record<string, number> = {};
  const utsendinger: Utsending[] = [];
  let alleredeSendt = 0;
  if (arrangement.neste) {
    const tekst = byggPaaminnelsestekst(arrangement.navn, arrangement.neste);
    for (const personId of paameldte) {
      const person = (tilstand.personer as any[]).find((rad) => rad.personId === personId);
      if (!person?.syntetiskFodselsnummer) continue;
      const rad = await sendEnkeltvarsel({
        personId,
        fnr: person.syntetiskFodselsnummer,
        varseltype: "paaminnelse",
        tilbudId: valg.tilbudId,
        dato: arrangement.neste.dato,
        tekst
      }, { sporingsId: valg.sporingsId, hjemmel: PAAMELDINGSHJEMMEL });
      if (!rad) { alleredeSendt += 1; continue; }
      perKanal[rad.kanal ?? "INGEN"] = (perKanal[rad.kanal ?? "INGEN"] ?? 0) + 1;
      utsendinger.push(rad);
    }
  }

  return {
    hjemmel: PAAMELDINGSHJEMMEL,
    tilbudId: arrangement.tilbudId,
    navn: arrangement.navn,
    neste: arrangement.neste,
    paameldte: paameldte.length,
    perKanal,
    alleredeSendt,
    utsendinger
  };
}

export type Varslingsresultat = {
  /** Grunnlaget, med i svaret så en flate ikke må bære sin egen kopi av det. */
  hjemmel: typeof VARSELHJEMMEL;
  torrkjoer: boolean;
  kommunenummer: string;
  vurdert: number;
  alleredeSendt: number;
  /** Antall per kanal, `INGEN` inkludert. Den er et utfall, ikke en feil. */
  perKanal: Record<string, number>;
  feilet: number;
  utsendinger: Utsending[];
};

async function sendVarsel(kandidat: Varselkandidat, sporingsId: string) {
  return tryUpstream<{ varselId?: string; kanal?: Varselkanal; grunn?: Varselgrunn }>(
    { service: "Fiks-simulatoren", action: "Å sende varselet" },
    async () => fetch(`${fiksBaseUrl}/fiks/varsler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await maskinportenHeader(fiksVarselToken))
      },
      body: JSON.stringify({
        type: kandidat.varseltype,
        digitalId: kandidat.fnr,
        tekst: kandidat.tekst,
        eksternReferanse: `${utsendingsnoekkel(kandidat)}:${sporingsId}`
      })
    })
  );
}

/**
 * Kjører varslingen. Én kodevei for CLI-en og for HTTP-triggeren.
 *
 * Nøkkelen klemmes fast *før* vi sender, inne i den samme køen som skriver
 * ledgeren. To samtidige kjøringer kan derfor ikke begge se «ikke sendt ennå» og
 * begge sende: den ene får raden, den andre får ingenting å gjøre. Å lese først
 * og skrive etterpå ville vært den tapte oppdateringen som `pnpm test:concurrency`
 * finnes for - og her er den et dobbelt brev til en innbygger.
 */
export async function kjoerVarsling(
  tilstand: State,
  valg: { sporingsId: string; torrkjoer?: boolean }
): Promise<Varslingsresultat> {
  const ordning = tilstand.satser.ordninger.find((kandidat) => kandidat.id === "seniorsirkel");
  if (!ordning) {
    throw new Error("Ordningen seniorsirkel finnes ikke i data/satser.json.");
  }
  const katalog = parseAktivitetskatalog(await readJson(senioraktivitetFil));
  const kandidater = finnVarselkandidater(
    tilstand, ordning, katalog.kommunenummer, byggVarseltekst(katalog.kommunenavn));

  // Utvalget er behandlingen som trenger en hjemmel, og den føres uansett om noe
  // faktisk sendes. En tørrkjøring har lest befolkningen like fullt.
  await addRevisjon({
    sporingsId: valg.sporingsId,
    handling: "VARSELUTVALG_UTFOERT",
    ressurs: "varselutvalg",
    formaal: VARSELHJEMMEL.formaal,
    aktor: { type: "system", id: "sandbox-backend" },
    grunnlag: {
      type: "hjemmel",
      behandlingsgrunnlag: VARSELHJEMMEL.behandlingsgrunnlag,
      suppleringsgrunnlag: VARSELHJEMMEL.suppleringsgrunnlag,
      antallKandidater: kandidater.length,
      torrkjoer: Boolean(valg.torrkjoer)
    }
  });

  const naa = new Date().toISOString();
  if (valg.torrkjoer) {
    const sendt = new Set<string>(
      ((await readJson("utsendinger.json", [])) as Utsending[]).map((rad) => rad.noekkel));
    const nye = kandidater.filter((kandidat) => !sendt.has(utsendingsnoekkel(kandidat)));
    return {
      hjemmel: VARSELHJEMMEL,
      torrkjoer: true,
      kommunenummer: katalog.kommunenummer,
      vurdert: kandidater.length,
      alleredeSendt: kandidater.length - nye.length,
      perKanal: {},
      feilet: 0,
      utsendinger: nye.map((kandidat) => ({
        noekkel: utsendingsnoekkel(kandidat),
        varseltype: kandidat.varseltype,
        personId: kandidat.personId,
        status: "planlagt" as const,
        tidspunkt: naa
      }))
    };
  }

  const klemt: Varselkandidat[] = await updateJson(
    "utsendinger.json", [], (utsendinger: Utsending[]) => {
      const finnes = new Set(utsendinger.map((rad) => rad.noekkel));
      const nye = kandidater.filter((kandidat) => !finnes.has(utsendingsnoekkel(kandidat)));
      for (const kandidat of nye) {
        utsendinger.push({
          noekkel: utsendingsnoekkel(kandidat),
          varseltype: kandidat.varseltype,
          personId: kandidat.personId,
          ...(kandidat.tilbudId ? { tilbudId: kandidat.tilbudId } : {}),
          ...(kandidat.dato ? { dato: kandidat.dato } : {}),
          status: "paabegynt",
          tidspunkt: naa
        });
      }
      return nye;
    });

  const perKanal: Record<string, number> = {};
  let feilet = 0;
  const utsendinger: Utsending[] = [];
  for (const kandidat of klemt) {
    const svar = await sendVarsel(kandidat, valg.sporingsId);
    const noekkel = utsendingsnoekkel(kandidat);
    const oppdatering: Partial<Utsending> = svar.ok
      ? {
        // «Ikke nådd» er ikke «feilet». Fiks svarte, avgjørelsen ble tatt, og
        // svaret var at hun ikke kan nås - det er en opplysning kommunen skal ha.
        status: svar.data?.kanal === "INGEN" ? "ikke_naadd" : "sendt",
        ...(svar.data?.kanal ? { kanal: svar.data.kanal } : {}),
        ...(svar.data?.grunn ? { grunn: svar.data.grunn } : {}),
        ...(svar.data?.varselId ? { varselId: svar.data.varselId } : {})
      }
      : { status: "feilet", feil: svar.error.message };
    if (svar.ok) {
      const kanal = svar.data?.kanal ?? "INGEN";
      perKanal[kanal] = (perKanal[kanal] ?? 0) + 1;
    } else {
      feilet += 1;
    }
    const oppdatert: Utsending = await updateJson(
      "utsendinger.json", [], (rader: Utsending[]) => {
        const rad = rader.find((kandidatrad) => kandidatrad.noekkel === noekkel)!;
        Object.assign(rad, oppdatering, { tidspunkt: new Date().toISOString() });
        return rad;
      });
    utsendinger.push(oppdatert);
  }

  return {
    hjemmel: VARSELHJEMMEL,
    torrkjoer: false,
    kommunenummer: katalog.kommunenummer,
    vurdert: kandidater.length,
    alleredeSendt: kandidater.length - klemt.length,
    perKanal,
    feilet,
    utsendinger
  };
}
