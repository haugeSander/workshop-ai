// The deterministic scoring behind «hva finnes for meg?» in Ringerike.
//
// Pure and synchronous, for the same reason vilkaar.ts is: the catalogue arrives
// as a parameter, never as a fetch, so an outcome can be pinned with a literal
// fixture and no running services. scripts/test-seniorsirkel.ts is that pinning.
//
// The model does not rank and does not decide. It is handed the best scoring
// tilbud and the begrunnelseskoder below, and writes why they fit - the same
// division of labour as everywhere else in this sandbox.
//
// The score is never written by hand: it is the sum of the weights of the codes
// that fired. One source of truth means a new signal is a row in VEKT and a row
// in the union, and it cannot disagree with the number it produced.
import { alderVed } from "../../shared/alder.ts";
import type { Aktivitetskatalog, Maalgruppe, Seniortilbud, Tilbud }
  from "../../shared/senioraktivitet.ts";

/**
 * Hvorfor et tilbud skårer som det gjør, positivt og negativt i samme union.
 *
 * Kodene er wire: de går til modellen, som skriver setningen innbyggeren leser.
 * Derfor er de en union og ikke `string` - en skrivefeil ville gitt en kode ingen
 * prompt kjenner igjen, og det ville vist seg først når en innbygger nådde den.
 *
 * Tre av dem sier «ikke oppgitt» framfor «nei», og det er med vilje. Katalogen
 * bærer ukjent tilgjengelighet som ukjent (se `Tilgjengelighet` i
 * apps/shared/senioraktivitet.ts), og skåringen som gjør det samme er den eneste
 * som ikke enten skjuler et tilbud innbyggeren godt kan møte på, eller sender
 * henne til et hun ikke kommer inn på.
 */
export const BEGRUNNELSESKODER = [
  "treffer_interesse",
  "utenfor_interessene",
  "i_maalgruppen",
  "gjelder_alle",
  "utenfor_maalgruppen",
  "maalgruppe_ukjent",
  "rullestoladkomst",
  "rullestol_ikke_oppgitt",
  "mangler_rullestoladkomst",
  "teleslynge",
  "teleslynge_mangler",
  "teleslynge_ikke_oppgitt",
  "utenfor_kommunen"
] as const;
export type Begrunnelseskode = (typeof BEGRUNNELSESKODER)[number];

/**
 * Kodene som utelukker et tilbud framfor å trekke fra poeng.
 *
 * Bare to, og begge er krav loven eller fysikken stiller, ikke preferanser:
 * katalogen gjelder én kommune, og en dør en rullestol ikke kommer gjennom er
 * ikke et tilbud med lavere skår. Alt annet er signaler.
 */
const HARDE_KRAV: readonly Begrunnelseskode[] = [
  "utenfor_kommunen",
  "mangler_rullestoladkomst"
];

/**
 * Vekten hver kode har. Null betyr «sies, men teller ikke» - en kode uten poeng
 * er fortsatt noe modellen skal kunne skrive om, som at adkomsten ikke er oppgitt.
 *
 * Interessen veier tyngst fordi den er innbyggerens eget svar; alderen og
 * tilretteleggingen er opplysninger om tilbudet. Tallene er relative og har ingen
 * enhet - de rangerer, de måler ikke.
 */
const VEKT: Record<Begrunnelseskode, number> = {
  treffer_interesse: 10,
  utenfor_interessene: 0,
  i_maalgruppen: 4,
  gjelder_alle: 2,
  utenfor_maalgruppen: 0,
  maalgruppe_ukjent: 0,
  rullestoladkomst: 3,
  rullestol_ikke_oppgitt: 0,
  mangler_rullestoladkomst: 0,
  teleslynge: 3,
  teleslynge_mangler: 0,
  teleslynge_ikke_oppgitt: 0,
  utenfor_kommunen: 0
};

/** En interessegruppe slik den står i data/seniorsirkel-grupper.json. */
export type Interessegruppe = {
  verdi: string;
  label: string;
  kategorier: string[];
};

/**
 * Det skåringen vet om innbyggeren. `kategorier` er utledet av `interesser` og
 * skrives aldri for hånd - bruk `byggSeniorprofil`, som slår gruppene opp i
 * kategoriene kommunen sorterer tilbudene under.
 *
 * `alder` er valgfri fordi portalen kan spørre uten å ha personen: da er
 * målgruppen ukjent framfor bommet. Se `vurderMaalgrupper`.
 */
export type Seniorprofil = {
  kommunenummer: string;
  alder?: number;
  interesser: string[];
  kategorier: string[];
  trengerRullestoladkomst?: boolean;
  trengerTeleslynge?: boolean;
};

export type Skaaring = {
  /**
   * `null` når et hardt krav ikke er oppfylt. Null poeng er ikke det samme: et
   * tilbud uten et eneste treff er fortsatt et tilbud innbyggeren kan møte på.
   */
  score: number | null;
  begrunnelseskoder: Begrunnelseskode[];
};

export type Forslag = Skaaring & {
  aktivitetId: string;
  navn: string;
  kategori: string;
  beskrivelse: string;
  tilbudId: string;
  tilbyder: string;
  /** Kommunens eget statusord, båret videre urørt. Se `rangerTilbud`. */
  status: string;
  score: number;
};

export type Utelukket = Skaaring & {
  aktivitetId: string;
  tilbudId: string;
  score: null;
};

export type Forslagsresultat = {
  /** Katalogens kommune, ikke innbyggerens. De må være like for at noe skåres. */
  kommunenummer: string;
  antallVurdert: number;
  forslag: Forslag[];
  utelukkede: Utelukket[];
};

function krev(betingelse: unknown, melding: string): void {
  if (!betingelse) throw new Error(`Seniorsirkel: ${melding}`);
}

/**
 * Leser interessegruppene og feiler høyt på en rad som mangler noe.
 *
 * Gruppene er data og ikke et kodeverk, fordi listen skal kunne endres uten en
 * kodeendring - se apps/shared/senioraktivitet.ts. Da er dette og
 * scripts/valider-data.ts de eneste vaktene mot en skrivefeil i en gruppeverdi.
 */
export function parseInteressegrupper(raa: unknown): Interessegruppe[] {
  const rot = (raa ?? {}) as Record<string, unknown>;
  krev(Array.isArray(rot.grupper) && (rot.grupper as unknown[]).length > 0,
    "gruppefilen mangler `grupper`.");
  const sette = new Set<string>();
  return (rot.grupper as unknown[]).map((rad, i) => {
    const g = (rad ?? {}) as Record<string, unknown>;
    const verdi = String(g.verdi ?? "");
    krev(/^[a-z0-9-]+$/.test(verdi),
      `gruppe nummer ${i + 1} har verdien «${verdi}». En gruppeverdi er en `
      + "identifikator: små bokstaver, tall og bindestrek.");
    krev(!sette.has(verdi), `gruppen ${verdi} finnes to ganger.`);
    sette.add(verdi);
    krev(String(g.label ?? "").trim().length > 0, `gruppen ${verdi} mangler \`label\`.`);
    krev(Array.isArray(g.kategorier) && (g.kategorier as unknown[]).length > 0,
      `gruppen ${verdi} peker ikke på noen kategori. Da er den en valgmulighet `
      + "uten innhold.");
    return {
      verdi,
      label: String(g.label),
      kategorier: (g.kategorier as unknown[]).map(String)
    };
  });
}

/**
 * Profilen, med gruppene løst opp i kommunens kategorier.
 *
 * Alderen regnes med `alderVed` mot en oppgitt referansedato - den samme datoen
 * vilkåret bruker (`satser.gjelderFra`), slik at katalogens målgrupper og retten
 * til ordningen måler mot samme dag. Ingen `new Date()`: se datoavsnittet i
 * AGENTS.md.
 *
 * En ukjent gruppeverdi kastes framfor å ignoreres. Ignorert ville den blitt til
 * «innbyggeren traff ingenting», og en skrivefeil i en spørring hadde sett ut som
 * et tomt tilbudsutvalg.
 */
export function byggSeniorprofil(
  inn: {
    kommunenummer: string;
    foedselsdato?: string;
    referansedato?: string;
    interesser?: string[];
    trengerRullestoladkomst?: boolean;
    trengerTeleslynge?: boolean;
  },
  grupper: Interessegruppe[]
): Seniorprofil {
  krev(/^[0-9]{4}$/.test(String(inn.kommunenummer)),
    `kommunenummeret «${String(inn.kommunenummer)}» er ikke fire siffer.`);

  const kjente = new Map(grupper.map((g) => [g.verdi, g]));
  const interesser: string[] = [];
  for (const valgt of inn.interesser ?? []) {
    const gruppe = kjente.get(valgt);
    krev(gruppe, `interessegruppen «${valgt}» finnes ikke. Gyldige: `
      + `${[...kjente.keys()].join(", ")}.`);
    if (!interesser.includes(valgt)) interesser.push(valgt);
  }
  const kategorier = [...new Set(
    interesser.flatMap((verdi) => kjente.get(verdi)!.kategorier)
  )].sort();

  const alder = inn.foedselsdato && inn.referansedato
    ? alderVed(inn.foedselsdato, inn.referansedato)
    : undefined;

  return {
    kommunenummer: String(inn.kommunenummer),
    ...(alder === undefined ? {} : { alder }),
    interesser,
    kategorier,
    ...(inn.trengerRullestoladkomst === undefined
      ? {} : { trengerRullestoladkomst: inn.trengerRullestoladkomst }),
    ...(inn.trengerTeleslynge === undefined
      ? {} : { trengerTeleslynge: inn.trengerTeleslynge })
  };
}

/**
 * Innbyggerens eget svar på ett felt, uansett hvordan prosessen har delt opp
 * spørsmålene sine.
 *
 * **Feltnavnet er kontrakten, ikke steg-id-en.** Et steg som *heter* `interesser`
 * teller, og det gjør også et felt som heter `interesser` inne i svaret på et steg
 * som heter noe annet. Alternativet var å navngi stegene i én bestemt prosess her,
 * og process-agent har alt vist hva det koster - se de hardkodede steg-id-ene for
 * `fartsdempende-tiltak` i AGENTS.md.
 */
function svarFelt(oektsvar: unknown, felt: string): string | null {
  if (!oektsvar || typeof oektsvar !== "object") return null;
  const svar = oektsvar as Record<string, unknown>;
  if (typeof svar[felt] === "string") return svar[felt] as string;
  for (const verdi of Object.values(svar)) {
    if (verdi && typeof verdi === "object") {
      const inni = (verdi as Record<string, unknown>)[felt];
      if (typeof inni === "string") return inni;
    }
  }
  return null;
}

/**
 * Interessegruppene, som kommaliste.
 *
 * Vakten mot `{svar.…}` er ikke teoretisk: et `DATA_FETCH`-steg som peker på et
 * spørsmål uten svar lar plassholderen stå i URL-en - se `replaceParametere` i
 * prosess.ts og kommentaren der. Uten dette ble den lest som et gruppenavn, og
 * innbyggeren fikk «interessegruppen «{svar.interesser}» finnes ikke», som leser
 * som hennes skrivefeil.
 */
function lesInteresser(raa: string | null): string[] {
  if (!raa) return [];
  krev(!raa.includes("{svar."),
    `spørringen inneholder plassholderen ${raa}. Steget den peker på er ikke besvart.`);
  return raa.split(",").map((verdi) => verdi.trim()).filter(Boolean);
}

/**
 * Et tilretteleggingsbehov, i tre tilstander.
 *
 * Ja og nei er de to som svarer; alt annet - «Vet ikke» fra et `ja-nei`-felt, en
 * tom streng, en parameter som ikke står der - utelates, og da sier ikke profilen
 * noe om behovet. Det er den samme regelen katalogen følger for tilgjengelighet,
 * og den må gjelde i begge ender: en «Vet ikke» lest som nei ville skjult
 * ingenting, mens en lest som ja ville filtrert bort tilbud innbyggeren aldri ba
 * om å slippe.
 *
 * To vokabularer, fordi det er to kilder: spørringen er maskin (`true`/`false`),
 * mens `ja-nei`-feltet er det innbyggeren klikket på.
 */
function lesBehov(raa: string | null): boolean | undefined {
  const verdi = (raa ?? "").trim().toLowerCase();
  if (verdi === "true" || verdi === "ja") return true;
  if (verdi === "false" || verdi === "nei") return false;
  return undefined;
}

/**
 * Én profil, uansett hvilken vei innbyggeren kom inn.
 *
 * Portalen kaller ruten med spørreparametere, og prosessmotoren kaller den med en
 * økt bak seg. De to skal oppføre seg likt, og den eneste måten å love det på er
 * at det er én funksjon og ikke to som skal holde tritt. Spørringen vinner der
 * begge svarer: motoren setter selv inn `{svar.<steg>}` i `api`-strengen, så en
 * verdi i spørringen er noe kalleren har sagt uttrykkelig.
 *
 * Kommunen og fødselsdatoen står ikke blant kildene, og det er med vilje. De er
 * registeropplysninger, og en kaller som kunne oppgi kommunen sin selv hadde gjort
 * det harde kravet i `rangerTilbud` til en innstilling.
 */
export function byggProfilFraKilder(
  kilder: {
    kommunenummer: string;
    foedselsdato?: string;
    referansedato?: string;
    spoerring?: { grupper?: string | null; rullestol?: string | null; teleslynge?: string | null };
    oektsvar?: unknown;
  },
  grupper: Interessegruppe[]
): Seniorprofil {
  const spoerring = kilder.spoerring ?? {};
  const fra = (navn: "grupper" | "rullestol" | "teleslynge", felt: string) =>
    spoerring[navn] ?? svarFelt(kilder.oektsvar, felt);

  const rullestol = lesBehov(fra("rullestol", "rullestol"));
  const teleslynge = lesBehov(fra("teleslynge", "teleslynge"));
  return byggSeniorprofil({
    kommunenummer: kilder.kommunenummer,
    ...(kilder.foedselsdato === undefined ? {} : { foedselsdato: kilder.foedselsdato }),
    ...(kilder.referansedato === undefined ? {} : { referansedato: kilder.referansedato }),
    interesser: lesInteresser(fra("grupper", "interesser")),
    ...(rullestol === undefined ? {} : { trengerRullestoladkomst: rullestol }),
    ...(teleslynge === undefined ? {} : { trengerTeleslynge: teleslynge })
  }, grupper);
}

/**
 * Målgruppekoden aktiviteten fortjener - én, den beste av målgruppene sine.
 *
 * Rekkefølgen under er hele regelen: et treff slår «gjelder alle», som slår
 * ukjent, som slår bom. Ukjent ligger over bom fordi de to ikke er det samme.
 * En målgruppe som bare peker ut et kriterium - «har behov for sosial kontakt» -
 * kan ikke måles mot en profil som ikke bærer det, og da er det ærlige svaret at
 * vi ikke vet, ikke at hun står utenfor.
 */
function vurderMaalgrupper(profil: Seniorprofil, maalgrupper: Maalgruppe[]): Begrunnelseskode {
  const rangering: Begrunnelseskode[] = [
    "utenfor_maalgruppen", "maalgruppe_ukjent", "gjelder_alle", "i_maalgruppen"
  ];
  let beste: Begrunnelseskode = "utenfor_maalgruppen";
  const loeft = (kode: Begrunnelseskode) => {
    if (rangering.indexOf(kode) > rangering.indexOf(beste)) beste = kode;
  };

  for (const maalgruppe of maalgrupper) {
    if (maalgruppe.gjelderAlle) { loeft("gjelder_alle"); continue; }
    // Alderen avgjør når den er oppgitt på begge sider. Et kriterium ved siden av
    // den overprøver ikke et treff: kriteriene er ikke et vilkår, og vilkåret bor
    // i vilkaar.ts.
    if (maalgruppe.alder) {
      if (profil.alder === undefined) { loeft("maalgruppe_ukjent"); continue; }
      const fra = maalgruppe.alder.fraAar ?? 0;
      const til = maalgruppe.alder.tilAar ?? Number.POSITIVE_INFINITY;
      loeft(profil.alder >= fra && profil.alder <= til
        ? "i_maalgruppen" : "utenfor_maalgruppen");
      continue;
    }
    loeft("maalgruppe_ukjent");
  }
  return beste;
}

/**
 * Skårer ett tilbud mot én profil.
 *
 * Kommunen sjekkes ikke her, og det er ikke en glipp: kommunen er en opplysning
 * om katalogen og ikke om det enkelte tilbudet, så den avgjøres én gang i
 * `rangerTilbud` framfor å bli stilt like mange ganger som det finnes rader.
 */
export function scoreTilbud(
  profil: Seniorprofil,
  aktivitet: Seniortilbud,
  tilbud: Tilbud
): Skaaring {
  const koder: Begrunnelseskode[] = [];

  // Ingen valgte interesser er ikke det samme som å bomme på alle: portalen kan
  // spørre «hva finnes for meg» uten å ha spurt om noe først. Da sies ingenting
  // om interesser, framfor at hvert tilbud bærer et avslag på et spørsmål som
  // aldri ble stilt.
  if (profil.kategorier.length > 0) {
    koder.push(profil.kategorier.includes(aktivitet.kategori)
      ? "treffer_interesse" : "utenfor_interessene");
  }

  koder.push(vurderMaalgrupper(profil, aktivitet.maalgrupper));

  if (profil.trengerRullestoladkomst === true) {
    const rullestol = tilbud.tilgjengelighet?.rullestol;
    if (rullestol === true) koder.push("rullestoladkomst");
    else if (rullestol === false) koder.push("mangler_rullestoladkomst");
    else koder.push("rullestol_ikke_oppgitt");
  }

  // Teleslynge filtrerer ikke. Ni av ti tilbud i katalogen ville falt bort, og en
  // liste som er tom fordi kravet var for hardt hjelper ingen - dette er et
  // signal, og «ikke oppgitt» vises som nettopp det.
  if (profil.trengerTeleslynge === true) {
    const teleslynge = tilbud.tilgjengelighet?.teleslynge;
    if (teleslynge === true) koder.push("teleslynge");
    else if (teleslynge === false) koder.push("teleslynge_mangler");
    else koder.push("teleslynge_ikke_oppgitt");
  }

  return byggSkaaring(koder);
}

/** Skåringen av en kodeliste. Det ene stedet et poengtall blir til. */
function byggSkaaring(koder: Begrunnelseskode[]): Skaaring {
  if (koder.some((kode) => HARDE_KRAV.includes(kode))) {
    return { score: null, begrunnelseskoder: koder };
  }
  return {
    score: koder.reduce((sum, kode) => sum + VEKT[kode], 0),
    begrunnelseskoder: koder
  };
}

/**
 * En utelukket rad. Kodene går gjennom `byggSkaaring` framfor å sette `score`
 * direkte, slik at et hardt krav som mister utelukkelsen sin blir en typefeil
 * her framfor en rad som stille flytter seg over i forslagene.
 */
function utelukk(
  aktivitetId: string,
  tilbudId: string,
  koder: Begrunnelseskode[]
): Utelukket {
  const skaaring = byggSkaaring(koder);
  krev(skaaring.score === null,
    `${tilbudId} ble utelukket uten at noen av kodene ${koder.join(", ")} er et hardt krav.`);
  return { aktivitetId, tilbudId, score: null, begrunnelseskoder: skaaring.begrunnelseskoder };
}

/**
 * Hele katalogen skåret mot én profil, sortert.
 *
 * Rekkefølgen er skår, så aktivitetId, så tilbudId. De to siste er der for at to
 * kjøringer av samme data skal gi samme liste: en usortert likhet ville flyttet
 * seg med innsettingsrekkefølgen i filen, og kontraktdumpen ville sett en endring
 * ingen hadde gjort.
 *
 * De utelukkede blir stående, med kodene sine. En innbygger som har oppgitt at hun
 * bruker rullestol har krav på å få vite at det finnes fire turgrupper hun ikke
 * kommer inn på, framfor at de forsvinner uten spor.
 */
export function rangerTilbud(
  profil: Seniorprofil,
  katalog: Aktivitetskatalog
): Forslagsresultat {
  const tilbydere = new Map(katalog.tilbydere.map((t) => [t.tilbyderId, t.navn]));
  const rader = katalog.aktiviteter.flatMap((aktivitet) =>
    aktivitet.tilbud.map((tilbud) => ({ aktivitet, tilbud })));

  // Katalogen gjelder én kommune. Er det ikke innbyggerens, er hvert tilbud i den
  // utelukket av samme grunn, og det sies én gang per rad framfor å bli en tom
  // liste uten forklaring.
  if (katalog.kommunenummer !== profil.kommunenummer) {
    return {
      kommunenummer: katalog.kommunenummer,
      antallVurdert: rader.length,
      forslag: [],
      utelukkede: rader.map(({ aktivitet, tilbud }) =>
        utelukk(aktivitet.aktivitetId, tilbud.tilbudId, ["utenfor_kommunen"]))
    };
  }

  const forslag: Forslag[] = [];
  const utelukkede: Utelukket[] = [];
  for (const { aktivitet, tilbud } of rader) {
    const skaaring = scoreTilbud(profil, aktivitet, tilbud);
    if (skaaring.score === null) {
      utelukkede.push(utelukk(
        aktivitet.aktivitetId, tilbud.tilbudId, skaaring.begrunnelseskoder));
      continue;
    }
    forslag.push({
      aktivitetId: aktivitet.aktivitetId,
      navn: aktivitet.navn,
      kategori: aktivitet.kategori,
      beskrivelse: aktivitet.beskrivelse,
      tilbudId: tilbud.tilbudId,
      tilbyder: tilbydere.get(tilbud.tilbyderId) ?? tilbud.tilbyderId,
      // Kommunens eget ord, ikke vårt. `krever-verifisering` betyr at et menneske
      // ennå ikke har sett på raden, og det skal kunne stå i teksten innbyggeren
      // leser - derfor bæres det videre framfor å bli oversatt til en kode her.
      status: tilbud.status,
      score: skaaring.score,
      begrunnelseskoder: skaaring.begrunnelseskoder
    });
  }

  forslag.sort((a, b) =>
    b.score - a.score
    || a.aktivitetId.localeCompare(b.aktivitetId, "nb")
    || a.tilbudId.localeCompare(b.tilbudId, "nb"));
  utelukkede.sort((a, b) =>
    a.aktivitetId.localeCompare(b.aktivitetId, "nb")
    || a.tilbudId.localeCompare(b.tilbudId, "nb"));

  return {
    kommunenummer: katalog.kommunenummer,
    antallVurdert: rader.length,
    forslag,
    utelukkede
  };
}

/** Vekten en kode har. Finnes for at testen skal kunne måle summen mot delene. */
export function vektFor(kode: Begrunnelseskode): number {
  return VEKT[kode];
}

/** Om koden utelukker framfor å trekke poeng. Samme grunn som `vektFor`. */
export function erHardtKrav(kode: Begrunnelseskode): boolean {
  return HARDE_KRAV.includes(kode);
}
