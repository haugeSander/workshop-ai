import { readFile } from "node:fs/promises";
import { alderVed, norskKalenderdato } from "../../shared/alder.ts";
import { readJson, updateJson } from "../../shared/jsonstore.ts";

export type Tilgjengelighet = {
  rullestol?: boolean;
  teleslynge?: boolean;
};

export type Tidspunkt = {
  ukedager: string[];
  fraKlokkeslett: string;
  tilKlokkeslett?: string;
  sesong?: { fraMaaned: number; tilMaaned: number };
};

export type Tilbud = {
  tilbudId: string;
  tilbyderId: string;
  navn?: string;
  status: string;
  gjennomforing: { former: string[]; tilrettelegging?: string[] };
  tidspunkter?: Tidspunkt[];
  steder?: { navn: string }[];
  pris?: { type: string; beloepKr?: number; beskrivelse?: string };
  paamelding?: {
    kreves: boolean;
    informasjon?: string;
    kontakt?: Record<string, unknown>;
    kontakter?: Record<string, unknown>[];
  };
  kontakt?: Record<string, unknown>;
  tilgjengelighet?: Tilgjengelighet;
};

export type Seniortilbud = {
  aktivitetId: string;
  navn: string;
  kategori: string;
  beskrivelse: string;
  opprinnelse: string;
  status: string;
  maalgrupper: {
    maalgruppeId: string;
    gjelderAlle: boolean;
    alder?: { fraAar?: number; tilAar?: number };
    kriterier: { type: string; verdier: string[] }[];
  }[];
  tilbud: Tilbud[];
  kilder: { tittel: string; aar?: number; side?: number }[];
};

export type Tilbyder = {
  tilbyderId: string;
  navn: string;
  type: string;
  kontakt?: Record<string, unknown>;
};

type Aktivitetsdata = {
  kommunenavn?: string;
  kommunenummer?: string;
  schemaVersjon?: number;
  aktiviteter: Seniortilbud[];
  tilbydere: Tilbyder[];
};

export type Portalpreferanse = {
  personId: string;
  kategorier: string[];
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

const PORTALALDER = 62;
const fallbackDataUrl = new URL("../../../aktivitetstilbud.json", import.meta.url);
const backendDataUrl = new URL("../../../data/senioraktiviteter.json", import.meta.url);

async function readKatalog(): Promise<Aktivitetsdata> {
  try {
    return JSON.parse(await readFile(backendDataUrl, "utf8")) as Aktivitetsdata;
  } catch (feil) {
    if ((feil as NodeJS.ErrnoException).code !== "ENOENT") throw feil;
    return JSON.parse(await readFile(fallbackDataUrl, "utf8")) as Aktivitetsdata;
  }
}

const katalog = await readKatalog();
const KOMMUNENAVN = katalog.kommunenavn ?? "Ringerike";
const KOMMUNENUMMER = katalog.kommunenummer ?? "3305";
const SCHEMA_VERSJON = katalog.schemaVersjon ?? 1;
const kategorier = [...new Set(katalog.aktiviteter.map((aktivitet) => aktivitet.kategori))].sort();

export function hentAktivitetskategorier(): string[] {
  return [...kategorier];
}

export async function hentPortalpreferanse(personId: string): Promise<Portalpreferanse | null> {
  const preferanser = await readJson("innbyggerportal-preferanser.json", []);
  return preferanser.find((preferanse: Portalpreferanse) => preferanse.personId === personId) ?? null;
}

export async function lagrePortalpreferanse(
  personId: string,
  valgteKategorier: unknown,
  oppdatert: string = new Date().toISOString()
): Promise<Portalpreferanse> {
  const unike = Array.isArray(valgteKategorier)
    ? [...new Set(valgteKategorier.filter((kategori): kategori is string => typeof kategori === "string"))]
    : [];
  if (unike.length === 0 || unike.some((kategori) => !kategorier.includes(kategori))) {
    throw new Error("Velg minst én gyldig kategori.");
  }
  return updateJson("innbyggerportal-preferanser.json", [], (preferanser: Portalpreferanse[]) => {
    const preferanse = { personId, kategorier: unike.sort(), oppdatert };
    const indeks = preferanser.findIndex((kandidat) => kandidat.personId === personId);
    if (indeks === -1) preferanser.push(preferanse);
    else preferanser[indeks] = preferanse;
    return preferanse;
  });
}

export async function hentPortalregistreringer(personId: string): Promise<Portalregistrering[]> {
  const registreringer = await readJson("innbyggerportal-registreringer.json", []);
  return registreringer
    .filter((registrering: Portalregistrering) => registrering.personId === personId)
    .map(normalizePortalregistrering);
}

function normalizePortalregistrering(registrering: Partial<Portalregistrering> & { tilbudId: string }): Portalregistrering {
  const treff = finnPortaltilbud(registrering.tilbudId);
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
  return updateJson("innbyggerportal-registreringer.json", [], (registreringer: Portalregistrering[]) => {
    const registrerteAktiviteter = new Set(
      registreringer
        .filter((registrering) => registrering.personId === personId)
        .map((registrering) => normalizePortalregistrering(registrering).aktivitetId)
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

export function hentAktivitetskatalog() {
  return {
    kommunenavn: KOMMUNENAVN,
    kommunenummer: KOMMUNENUMMER,
    schemaVersjon: SCHEMA_VERSJON,
    aktiviteter: katalog.aktiviteter,
    tilbydere: katalog.tilbydere,
    mock: true,
    syntetisk: true
  };
}

export function hentPortaltilbud(
  foedselsdato: string,
  kommunenummer: string | null | undefined,
  referansedato: string = norskKalenderdato(),
  valgteKategorier?: string[]
) {
  const alder = alderVed(foedselsdato, referansedato);
  const portalTilgjengelig = alder >= PORTALALDER && kommunenummer === KOMMUNENUMMER;
  const forAlder = katalog.aktiviteter.filter((aktivitet) =>
    aktivitet.maalgrupper.some((maalgruppe) =>
      !maalgruppe.alder || (
        alder >= (maalgruppe.alder.fraAar ?? 0)
        && alder <= (maalgruppe.alder.tilAar ?? Number.POSITIVE_INFINITY)
      )
    )
  );
  const aktiviteter = valgteKategorier === undefined
    ? forAlder
    : forAlder.filter((aktivitet) => valgteKategorier.includes(aktivitet.kategori));
  return {
    alder,
    portalTilgjengelig,
    kommunenavn: KOMMUNENAVN,
    kommunenummer: KOMMUNENUMMER,
    schemaVersjon: SCHEMA_VERSJON,
    aktiviteter: portalTilgjengelig ? aktiviteter : [],
    tilbydere: portalTilgjengelig ? katalog.tilbydere : []
  };
}

export function finnPortaltilbud(tilbudId: string): {
  aktivitet: Seniortilbud;
  tilbud: Tilbud;
} | null {
  for (const aktivitet of katalog.aktiviteter) {
    const tilbud = aktivitet.tilbud.find((kandidat) => kandidat.tilbudId === tilbudId);
    if (tilbud) return { aktivitet, tilbud };
  }
  return null;
}