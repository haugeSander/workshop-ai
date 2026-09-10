/**
 * Reading and writing state for fiks-simulator.
 *
 * Reading per request is deliberate - a hand edit to a seed file takes effect
 * without a restart, which matters during a hackathon - and `createStateReader`
 * keeps it cheap: read lazily, once per request, and only what the route asks
 * for. Writes go through `updateJson` in apps/shared/jsonstore.ts; this file
 * only points at it.
 */

import type { Husstand, Krr, Person, Plass, Samtykke } from "../../shared/innbyggerdata.ts";
import type { FolkeregisterPerson } from "../../shared/registerdata.ts";
import type { Varselgrunn, Varselkanal, Varseltype } from "../../shared/varsel.ts";
import type { Forsendelse } from "./forsendelse.ts";
import type { Inntekt } from "../../shared/inntekt.ts";
export type { Inntekt, Inntektspost } from "../../shared/inntekt.ts";
// Same split as sandbox-backend, and the same two paths, because it is the same
// module: data/ is seed and stays untouched, state/ holds everything written at
// runtime and is gitignored. server.ts imports `updateJson` from there directly.
import { readJson } from "../../shared/jsonstore.ts";

/**
 * A per-request reader that loads each dataset at most once, on first use.
 *
 * Make one at the top of a request and hand it to the handlers; a route that only
 * touches samtykker never opens personer.json.
 */
/*
 * Datasettene denne tjenesten leser. Person, Husstand, Samtykke og Plass er
 * delt med sandbox-backend - samme filer på disk, så samme typer. Oppgave
 * og Melding finnes bare her.
 *
 * readJson gir `any`, som er riktig for en generisk JSON-leser. Typene settes
 * her, der filnavnet er kjent, slik at kallstedene ikke arver den any-en.
 */
export type Historikklinje = { tidspunkt: string; status: string };

export type Oppgave = {
  oppgaveId: string;
  personId?: string;
  soknadId?: string;
  tittel: string;
  status: string;
  opprettet: string;
  sporingsId: string;
  historikk?: Historikklinje[];
  syntetisk?: boolean;
};

export type Melding = {
  meldingId: string;
  tittel: string;
  innhold: string;
  opprettet: string;
  syntetisk?: boolean;
};

/**
 * Ett sendt varsel. `kanal` og `grunn` er avgjørelsen slik den ble tatt, lagret på
 * raden - ikke utledet på nytt ved lesing. Kontaktregisteret kan ha endret seg
 * siden, og spørsmålet loggen skal svare på er hva som faktisk gikk ut.
 *
 * `tekst` lagres. Det er en beskjed vi selv har skrevet til innbyggeren, ikke en
 * opplysning om henne, og «hva sto det i SMS-en» er det første noen spør om.
 * Telefonnummeret lagres derimot ikke: kanalen sier nok.
 */
export type Varsel = {
  varselId: string;
  type: Varseltype;
  digitalId: string;
  tekst: string;
  kanal: Varselkanal;
  grunn?: Varselgrunn;
  eksternReferanse?: string;
  opprettet: string;
  syntetisk?: boolean;
};

/** Samtykket slik denne tjenesten skriver det - videre enn backendens lesing. */
export type FiksSamtykke = Samtykke & {
  formaal?: string;
  opprettet: string;
  utloper?: string;
  sporingsId: string;
  historikk?: Historikklinje[];
  syntetisk?: boolean;
};

export function createStateReader() {
  const loaded = new Map<string, Promise<any>>();

  function read(fileName: string, standardverdi?: unknown): Promise<any> {
    if (!loaded.has(fileName)) {
      loaded.set(fileName, readJson(fileName, standardverdi));
    }
    return loaded.get(fileName)!;
  }

  return {
    personer: (): Promise<Person[]> => read("personer.json"),
    husstander: (): Promise<Husstand[]> => read("husstander.json"),
    inntekter: (): Promise<Inntekt[]> => read("inntekter.json"),
    krr: (): Promise<Krr[]> => read("krr.json"),
    // The seed wraps its rows in metadata (kilde, versjon, antall); the routes
    // only ever need the list.
    folkeregister: (): Promise<FolkeregisterPerson[]> =>
      read("folkeregister.seed.json").then((seed) => seed.personer || []),
    barnehageplasser: (): Promise<Plass[]> => read("barnehageplasser.json"),
    samtykker: (): Promise<FiksSamtykke[]> => read("samtykker.json", []),
    oppgaver: (): Promise<Oppgave[]> => read("oppgaver.json", []),
    forsendelser: (): Promise<Forsendelse[]> => read("forsendelser.json", []),
    meldinger: (): Promise<Melding[]> => read("meldinger.json", []),
    varsler: (): Promise<Varsel[]> => read("varsler.json", [])
  };
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
