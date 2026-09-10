import aktivitetsdata from "../../../aktivitetstilbud.json" with { type: "json" };
import { alderVed, norskKalenderdato } from "../../shared/alder.ts";

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
  aktiviteter: Seniortilbud[];
  tilbydere: Tilbyder[];
};

const PORTALALDER = 62;
const KOMMUNENAVN = "Ringerike";
const KOMMUNENUMMER = "3305";
const katalog = aktivitetsdata as Aktivitetsdata;

export function hentPortaltilbud(
  foedselsdato: string,
  kommunenummer: string | null | undefined,
  referansedato: string = norskKalenderdato()
) {
  const alder = alderVed(foedselsdato, referansedato);
  const portalTilgjengelig = alder >= PORTALALDER && kommunenummer === KOMMUNENUMMER;
  return {
    alder,
    portalTilgjengelig,
    kommunenavn: KOMMUNENAVN,
    kommunenummer: KOMMUNENUMMER,
    schemaVersjon: 1,
    aktiviteter: portalTilgjengelig ? katalog.aktiviteter : [],
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