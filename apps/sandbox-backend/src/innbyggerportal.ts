/*
 * Innbyggerportalens sammenstilling: «hva finnes for meg her?», ferdig til å vises.
 *
 * Portalen skårer ikke selv. `rangerTilbud` i seniorsirkel.ts er den eneste
 * skåringen i sandkassen, og denne modulen legger på det katalogen har av
 * praktiske opplysninger - tid, sted, pris, påmelding - som rangeringen med vilje
 * ikke bærer. Skillet er verdt å holde: en skåring som også skulle levere
 * visningsfelter hadde blitt et presentasjonslag, og da kunne den ikke lenger
 * pinnes mot en fixtur uten en frontend å sammenligne med.
 *
 * Modulen hadde sin egen filtrering før dette, og sin egen kopi av katalogtypene.
 * De to lå ved siden av rangeringen og var enklere enn den: ingen
 * tilgjengelighet, ingen begrunnelse, ingen utelukkede. Innbyggeren fikk altså
 * den svakeste av to implementasjoner, og den sterke hadde ingen brukere.
 */
import { alderVed } from "../../shared/alder.ts";
import { readJson, updateJson } from "../../shared/jsonstore.ts";
import { parseAktivitetskatalog } from "../../shared/senioraktivitet.ts";
import type {
  Aktivitetskatalog, Seniortilbud, Tilbud
} from "../../shared/senioraktivitet.ts";
import { senioraktivitetFil } from "./config.ts";
import { byggSeniorprofil, parseInteressegrupper, rangerTilbud } from "./seniorsirkel.ts";
import type {
  Begrunnelseskode, Forslag, Interessegruppe, Seniorprofil, Utelukket
} from "./seniorsirkel.ts";

/**
 * Innbyggerens valg, slik portalen lagrer dem.
 *
 * `grupper` er interessegruppene i data/seniorsirkel-grupper.json, ikke kommunens
 * tjenestekategorier. Det er hele poenget: en innbygger skal spørres om hva hun er
 * interessert i, ikke om hvilken kategori kommunen har sortert tilbudet under. Se
 * docs/seniorsirkel.md, «To lister, og hvorfor de ikke er like».
 *
 * `rullestol` og `teleslynge` er valgfrie fordi de har tre tilstander, ikke to.
 * Utelatt betyr *ikke oppgitt*, og skåringen behandler det som ukjent framfor som
 * nei - se `Tilgjengelighet` i apps/shared/senioraktivitet.ts.
 */
export type Portalpreferanse = {
  personId: string;
  grupper: string[];
  rullestol?: boolean;
  teleslynge?: boolean;
  oppdatert: string;
};

export type Portalregistrering = {
  registreringId: string;
  personId: string;
  aktivitetId: string;
  tilbudId: string;
  navn: string;
  status: "MOTTATT";
  opprettet: string;
  mock: true;
  syntetisk: true;
};

/**
 * Det katalogen har om et tilbud utover rangeringen: det innbyggeren trenger for å
 * vite om hun kan møte opp. Rangeringen svarer på om tilbudet passer, dette på
 * hvor og når.
 */
export type Tilbudsdetaljer = {
  /** Tilbudets eget navn, når det heter noe annet enn aktiviteten. */
  tilbudsnavn?: string;
  tilbyderId: string;
  former: string[];
  tilrettelegging: string[];
  tidspunkter: Tilbud["tidspunkter"];
  steder: Tilbud["steder"];
  pris?: Tilbud["pris"];
  paameldingKreves: boolean;
  kontakt: Record<string, unknown>;
  tilgjengelighet?: Tilbud["tilgjengelighet"];
};

export type Portaltilbud = Tilbudsdetaljer & {
  aktivitetId: string;
  tilbudId: string;
  navn: string;
  kategori: string;
  beskrivelse: string;
  tilbyder: string;
  status: string;
  /** `null` når et hardt krav utelukket tilbudet. Se `Skaaring` i seniorsirkel.ts. */
  score: number | null;
  begrunnelseskoder: Begrunnelseskode[];
};

export type Portalvisning = {
  personId: string;
  alder: number;
  portalTilgjengelig: boolean;
  aldersgrense: number;
  kommunenavn: string;
  kommunenummer: string;
  schemaVersjon: number;
  profil: Seniorprofil | null;
  antallVurdert: number;
  /** Tilbudene som traff en interesse hun valgte. */
  anbefalte: Portaltilbud[];
  /** Resten av det hun kan møte på. De forsvinner ikke fordi de ikke traff. */
  andre: Portaltilbud[];
  /** Tilbud et hardt krav stengte, med koden som sier hvorfor. */
  utelukkede: Portaltilbud[];
  valgtTilbud: Portaltilbud | null;
  preferanserValgt: boolean;
};

async function lesKatalog(): Promise<Aktivitetskatalog> {
  // Per kall og ikke mellomlagret ved oppstart, fordi `readJson` leter i `state/`
  // før `data/`: en katalog lagt i state/ skal virke med én gang. Ruten
  // /api/seniorsirkel/forslag leser på samme måte, og to lesere av den samme filen
  // med hver sin regel er nettopp det som gjør en overstyring halvveis.
  return parseAktivitetskatalog(await readJson(senioraktivitetFil));
}

async function lesGrupper(): Promise<Interessegruppe[]> {
  return parseInteressegrupper(await readJson("seniorsirkel-grupper.json"));
}

/**
 * Aldersgrensen for ordningen i kommunen, lest fra dataene.
 *
 * Tallet stod som en konstant her før, ved siden av det samme tallet i
 * data/tjenestetilbud.json som vilkåret måler mot. To tall for én grense er ett
 * for mange: en kommune som setter grensen til 60 hadde fått portalen til å si 62.
 */
async function hentAldersgrense(kommunenummer: string): Promise<number | null> {
  const tilbud = (await readJson("tjenestetilbud.json", [])) as {
    tjeneste?: string; kommunenummer?: string; malgruppeFraAar?: number;
  }[];
  const treff = tilbud.find((rad) =>
    rad.tjeneste === "seniorsirkel" && rad.kommunenummer === kommunenummer);
  return typeof treff?.malgruppeFraAar === "number" ? treff.malgruppeFraAar : null;
}

/** Gruppene innbyggeren velger mellom, med teksten hun leser. */
export async function hentInteressegrupper(): Promise<
  { verdi: string; label: string }[]
> {
  // `kategorier` blir med vilje ikke med ut: det er kommunens taksonomi, og en
  // portal som viser den fram har ikke sluttet å spørre om den.
  return (await lesGrupper()).map(({ verdi, label }) => ({ verdi, label }));
}

export async function hentAktivitetskatalog() {
  const katalog = await lesKatalog();
  return { ...katalog, mock: true, syntetisk: true };
}

/**
 * Preferansen som står lagret, renset for gruppeverdier som ikke finnes lenger.
 *
 * Rensingen er ikke pedanteri. Filen overlevde da portalen gikk fra kategorier til
 * interessegrupper, og en gammel rad bærer kategorinavn. Sendt videre urørt ville
 * `byggSeniorprofil` kastet «interessegruppen «dagaktivitet» finnes ikke», som
 * leser som innbyggerens skrivefeil. Blir det ingenting igjen, er svaret at hun
 * ikke har valgt ennå - og da spør portalen på nytt.
 */
export async function hentPortalpreferanse(personId: string): Promise<Portalpreferanse | null> {
  const preferanser = (await readJson("innbyggerportal-preferanser.json", [])) as
    (Portalpreferanse & { kategorier?: string[] })[];
  const rad = preferanser.find((preferanse) => preferanse.personId === personId);
  if (!rad) return null;
  const kjente = new Set((await lesGrupper()).map((gruppe) => gruppe.verdi));
  const grupper = (rad.grupper ?? []).filter((verdi) => kjente.has(verdi));
  if (grupper.length === 0) return null;
  return {
    personId,
    grupper,
    ...(typeof rad.rullestol === "boolean" ? { rullestol: rad.rullestol } : {}),
    ...(typeof rad.teleslynge === "boolean" ? { teleslynge: rad.teleslynge } : {}),
    oppdatert: rad.oppdatert
  };
}

/** Et tilretteleggingsbehov er ja, nei eller ikke oppgitt. Alt annet er ikke oppgitt. */
function lesBehov(raa: unknown): boolean | undefined {
  return typeof raa === "boolean" ? raa : undefined;
}

export async function lagrePortalpreferanse(
  personId: string,
  valg: { grupper?: unknown; rullestol?: unknown; teleslynge?: unknown },
  oppdatert: string = new Date().toISOString()
): Promise<Portalpreferanse> {
  const kjente = new Set((await lesGrupper()).map((gruppe) => gruppe.verdi));
  const unike = Array.isArray(valg.grupper)
    ? [...new Set(valg.grupper.filter((verdi): verdi is string => typeof verdi === "string"))]
    : [];
  if (unike.length === 0) {
    throw new Error("Velg minst én interessegruppe.");
  }
  const ukjent = unike.find((verdi) => !kjente.has(verdi));
  if (ukjent) {
    throw new Error(
      `Interessegruppen «${ukjent}» finnes ikke. Gyldige: ${[...kjente].join(", ")}.`);
  }
  const rullestol = lesBehov(valg.rullestol);
  const teleslynge = lesBehov(valg.teleslynge);
  return updateJson("innbyggerportal-preferanser.json", [], (preferanser: Portalpreferanse[]) => {
    const preferanse: Portalpreferanse = {
      personId,
      grupper: unike.sort(),
      ...(rullestol === undefined ? {} : { rullestol }),
      ...(teleslynge === undefined ? {} : { teleslynge }),
      oppdatert
    };
    const indeks = preferanser.findIndex((kandidat) => kandidat.personId === personId);
    if (indeks === -1) preferanser.push(preferanse);
    else preferanser[indeks] = preferanse;
    return preferanse;
  });
}

export async function hentPortalregistreringer(personId: string): Promise<Portalregistrering[]> {
  const registreringer = await readJson("innbyggerportal-registreringer.json", []);
  const katalog = await lesKatalog();
  return registreringer
    .filter((registrering: Portalregistrering) => registrering.personId === personId)
    .map((registrering: Portalregistrering) => normaliser(registrering, katalog));
}

function normaliser(
  registrering: Partial<Portalregistrering> & { tilbudId: string },
  katalog: Aktivitetskatalog
): Portalregistrering {
  const treff = slaaOppTilbud(katalog, registrering.tilbudId);
  return {
    registreringId: registrering.registreringId ?? `placeholder-registrering-${registrering.tilbudId}`,
    personId: registrering.personId ?? "ukjent",
    aktivitetId: registrering.aktivitetId ?? treff?.aktivitet.aktivitetId ?? registrering.tilbudId,
    tilbudId: registrering.tilbudId,
    navn: registrering.navn ?? treff?.tilbud.navn ?? treff?.aktivitet.navn ?? registrering.tilbudId,
    status: "MOTTATT",
    opprettet: registrering.opprettet ?? "2026-09-10T12:00:00.000Z",
    mock: true,
    syntetisk: true
  };
}

export async function lagrePortalregistreringer(
  personId: string,
  valgte: { aktivitet: Seniortilbud; tilbud: Tilbud }[],
  opprettet: string = new Date().toISOString()
): Promise<Portalregistrering[]> {
  const katalog = await lesKatalog();
  return updateJson("innbyggerportal-registreringer.json", [], (registreringer: Portalregistrering[]) => {
    const registrerteAktiviteter = new Set(
      registreringer
        .filter((registrering) => registrering.personId === personId)
        .map((registrering) => normaliser(registrering, katalog).aktivitetId)
    );
    if (valgte.some(({ aktivitet }) => registrerteAktiviteter.has(aktivitet.aktivitetId))) {
      throw new Error("Du er allerede påmeldt en av aktivitetene.");
    }
    const nye = valgte.map(({ aktivitet, tilbud }) => ({
      registreringId: `placeholder-registrering-${personId}-${tilbud.tilbudId}`,
      personId,
      aktivitetId: aktivitet.aktivitetId,
      tilbudId: tilbud.tilbudId,
      navn: tilbud.navn ?? aktivitet.navn,
      status: "MOTTATT" as const,
      opprettet,
      mock: true as const,
      syntetisk: true as const
    }));
    registreringer.push(...nye);
    return nye;
  });
}

export async function fjernPortalregistrering(
  personId: string,
  registreringId: string
): Promise<Portalregistrering | null> {
  const katalog = await lesKatalog();
  return updateJson("innbyggerportal-registreringer.json", [], (registreringer: Portalregistrering[]) => {
    const indeks = registreringer.findIndex(
      (registrering) => registrering.personId === personId && registrering.registreringId === registreringId
    );
    if (indeks === -1) return null;
    const [fjernet] = registreringer.splice(indeks, 1);
    return normaliser(fjernet!, katalog);
  });
}

function slaaOppTilbud(katalog: Aktivitetskatalog, tilbudId: string): {
  aktivitet: Seniortilbud;
  tilbud: Tilbud;
} | null {
  for (const aktivitet of katalog.aktiviteter) {
    const tilbud = aktivitet.tilbud.find((kandidat) => kandidat.tilbudId === tilbudId);
    if (tilbud) return { aktivitet, tilbud };
  }
  return null;
}

export async function finnPortaltilbud(tilbudId: string): Promise<{
  aktivitet: Seniortilbud;
  tilbud: Tilbud;
} | null> {
  return slaaOppTilbud(await lesKatalog(), tilbudId);
}

function detaljer(aktivitet: Seniortilbud, tilbud: Tilbud): Tilbudsdetaljer {
  return {
    ...(tilbud.navn ? { tilbudsnavn: tilbud.navn } : {}),
    tilbyderId: tilbud.tilbyderId,
    former: tilbud.gjennomforing.former,
    tilrettelegging: tilbud.gjennomforing.tilrettelegging,
    tidspunkter: tilbud.tidspunkter,
    steder: tilbud.steder,
    ...(tilbud.pris ? { pris: tilbud.pris } : {}),
    // Utelatt `paamelding` betyr at det ikke kreves noe, så portalen slipper å
    // skille mellom «ikke oppgitt» og «nei» her - det gjør katalogen alt.
    paameldingKreves: tilbud.paamelding?.kreves ?? false,
    kontakt: tilbud.kontakt,
    ...(tilbud.tilgjengelighet ? { tilgjengelighet: tilbud.tilgjengelighet } : {})
  };
}

/**
 * Én skåret rad, med det katalogen har om den.
 *
 * De utelukkede går gjennom den samme funksjonen som forslagene, og det er med
 * vilje: en innbygger som har oppgitt at hun bruker rullestol skal se hvilken
 * turgruppe hun ikke kommer inn på, med tid og sted, framfor et navn uten noe
 * rundt seg. Det er den opplysningen som lar henne ringe og spørre.
 */
function berik(
  katalog: Aktivitetskatalog,
  tilbydere: Map<string, string>,
  rad: Forslag | Utelukket
): Portaltilbud | null {
  const treff = slaaOppTilbud(katalog, rad.tilbudId);
  if (!treff) return null;
  const { aktivitet, tilbud } = treff;
  return {
    aktivitetId: aktivitet.aktivitetId,
    tilbudId: tilbud.tilbudId,
    navn: aktivitet.navn,
    kategori: aktivitet.kategori,
    beskrivelse: aktivitet.beskrivelse,
    tilbyder: tilbydere.get(tilbud.tilbyderId) ?? tilbud.tilbyderId,
    // Kommunens eget statusord, båret videre urørt - se `rangerTilbud`.
    status: tilbud.status,
    score: rad.score,
    begrunnelseskoder: rad.begrunnelseskoder,
    ...detaljer(aktivitet, tilbud)
  };
}

/**
 * Hele portalvisningen for én innbygger.
 *
 * `referansedato` er innbyggerens dag og ikke ordningens. Ruten
 * /api/seniorsirkel/forslag måler mot `satser.gjelderFra`, fordi den kan være et
 * `DATA_FETCH`-mål i en prosess som ender i et vedtak, og da skal katalogens
 * målgrupper og vilkåret svare for samme dag. Portalen spør om noe annet - «hva
 * finnes for meg nå» - og må bruke én dato til begge deler: en aldersgrense målt
 * mot i dag og en målgruppe målt mot en dato i fortiden ville sagt til en
 * nybakt 62-åring at hun er innenfor, og så at hun står utenfor hver målgruppe.
 */
export async function byggPortalvisning(inn: {
  personId: string;
  foedselsdato: string;
  kommunenummer: string | null | undefined;
  referansedato: string;
  preferanse: Portalpreferanse | null;
  registreringer: Portalregistrering[];
  valgtTilbudId?: string | null;
}): Promise<Portalvisning> {
  const katalog = await lesKatalog();
  const alder = alderVed(inn.foedselsdato, inn.referansedato);
  const aldersgrense = await hentAldersgrense(katalog.kommunenummer);
  const portalTilgjengelig = aldersgrense !== null
    && alder >= aldersgrense
    && inn.kommunenummer === katalog.kommunenummer;

  const tomt = {
    personId: inn.personId,
    alder,
    portalTilgjengelig,
    aldersgrense: aldersgrense ?? 0,
    kommunenavn: katalog.kommunenavn,
    kommunenummer: katalog.kommunenummer,
    schemaVersjon: katalog.schemaVersjon,
    profil: null,
    antallVurdert: 0,
    anbefalte: [],
    andre: [],
    utelukkede: [],
    valgtTilbud: null,
    preferanserValgt: inn.preferanse !== null
  };
  if (!portalTilgjengelig) return tomt;

  const profil = byggSeniorprofil({
    kommunenummer: String(inn.kommunenummer),
    foedselsdato: inn.foedselsdato,
    referansedato: inn.referansedato,
    interesser: inn.preferanse?.grupper ?? [],
    ...(inn.preferanse?.rullestol === undefined
      ? {} : { trengerRullestoladkomst: inn.preferanse.rullestol }),
    ...(inn.preferanse?.teleslynge === undefined
      ? {} : { trengerTeleslynge: inn.preferanse.teleslynge })
  }, await lesGrupper());

  const rangert = rangerTilbud(profil, katalog);
  const tilbydere = new Map(katalog.tilbydere.map((rad) => [rad.tilbyderId, rad.navn]));
  // Påmeldte aktiviteter tas ut av alle tre listene: de står under «Mine
  // påmeldinger», og et tilbud hun alt har meldt seg på er ikke et forslag.
  const paameldt = new Set(inn.registreringer.map((rad) => rad.aktivitetId));
  const beriket = (rader: (Forslag | Utelukket)[]) => rader
    .map((rad) => berik(katalog, tilbydere, rad))
    .filter((rad): rad is Portaltilbud => rad !== null && !paameldt.has(rad.aktivitetId));

  const forslag = beriket(rangert.forslag);
  const utelukkede = beriket(rangert.utelukkede);
  const traff = (rad: Portaltilbud) => rad.begrunnelseskoder.includes("treffer_interesse");
  const anbefalte = forslag.filter(traff);
  const andre = forslag.filter((rad) => !traff(rad));

  return {
    ...tomt,
    profil,
    antallVurdert: rangert.antallVurdert,
    anbefalte,
    andre,
    utelukkede,
    valgtTilbud: inn.valgtTilbudId
      ? [...forslag, ...utelukkede].find((rad) => rad.tilbudId === inn.valgtTilbudId) ?? null
      : null
  };
}
