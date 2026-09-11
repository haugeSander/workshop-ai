/*
 * Setningen som sier hvorfor et seniortilbud står i innbyggerens liste.
 *
 * **Modellen formulerer. Den rangerer ikke, og den avgjør ikke.** Skåringen i
 * `apps/sandbox-backend/src/seniorsirkel.ts` har alt bestemt hvilke tilbud som
 * er med, i hvilken rekkefølge og hvorfor - og «hvorfor» er en liste
 * begrunnelseskoder, ikke fritekst. Denne modulen gjør kodene om til én setning
 * et menneske kan lese. Kommer setningen ikke, eller kommer den gal, står den
 * deterministiske igjen, og innbyggeren merker ingen forskjell utover ordvalget.
 *
 * Egen fil og ikke i server.ts, av samme grunn som sporsmaalsperrer.ts: den
 * filen kaller `server.listen` på toppnivå og kan ikke importeres av en test.
 * Alt her er rene funksjoner, og `pnpm test:begrunnelse` kjører dem uten stack
 * og uten modell.
 *
 * Sperrene står i kode og ikke bare i prompten. En regel modellen blir bedt om å
 * følge holder mesteparten av tiden; en som håndheves på svaret holder hver
 * gang. Det er den samme arbeidsdelingen som `validateVarsellengde` på
 * Fiks-flaten og `validateAnswer` på /ai/sporsmaal.
 */
import { erBegrunnelseskode } from "../../shared/begrunnelse.ts";
import type { Begrunnelseskode } from "../../shared/begrunnelse.ts";
import { harBeslutningsspraak } from "./sporsmaalsperrer.ts";

/** Ett tilbud på vei inn. `begrunnelseskoder` er skåringens svar, ikke kallerens mening. */
export type Tilbudsinngang = {
  tilbudId: string;
  navn: string;
  beskrivelse: string;
  begrunnelseskoder: Begrunnelseskode[];
};

export type Begrunnelse = {
  tilbudId: string;
  tekst: string;
  /** `modell` når setningen kom fra modellen og besto sperrene, ellers `regel`. */
  kilde: "modell" | "regel";
  /** Hvorfor modellsvaret ble forkastet. Bare satt når `kilde` er `regel`. */
  avvist?: string;
};

/**
 * Hva hver kode betyr, i to former.
 *
 * `modell` er det modellen får se: en nøytral påstand om tilbudet og
 * innbyggeren, i tredje person, så modellen ikke bare kan skrive den av.
 * `standard` er leddet den deterministiske setningen bygges av, og står etter
 * «Tilbudet ». `null` betyr at koden ikke sier noe verdt å skrive - den er med i
 * skåringen fordi «vi vet ikke» ikke er det samme som «nei», og et merke som
 * sier «vi vet ikke» på hvert eneste kort er støy framfor opplysning.
 *
 * Totalt `Record` og ikke `Partial`: en ny kode i kodeverket er en typefeil her,
 * framfor en kode ingen prompt kjenner igjen når en innbygger når den.
 */
const KODEMENING: Record<Begrunnelseskode, { modell: string; standard: string | null }> = {
  treffer_interesse: {
    modell: "Kategorien tilbudet ligger i, er en innbyggeren har krysset av for.",
    standard: "passer med interessene du har valgt"
  },
  utenfor_interessene: {
    modell: "Tilbudet ligger utenfor det innbyggeren krysset av for.",
    standard: null
  },
  i_maalgruppen: {
    modell: "Alderen til innbyggeren er innenfor målgruppen tilbudet retter seg mot.",
    standard: "er rettet mot din aldersgruppe"
  },
  gjelder_alle: {
    modell: "Tilbudet er åpent for alle, uten aldersgrense.",
    standard: "er åpent for alle"
  },
  utenfor_maalgruppen: {
    modell: "Alderen til innbyggeren er utenfor målgruppen tilbudet retter seg mot.",
    standard: "er rettet mot en annen aldersgruppe"
  },
  maalgruppe_ukjent: {
    modell: "Det er ikke mulig å måle om innbyggeren er i målgruppen.",
    standard: null
  },
  rullestoladkomst: {
    modell: "Innbyggeren har oppgitt at hun trenger rullestoladkomst, og tilbudet har det.",
    standard: "har rullestoladkomst"
  },
  rullestol_ikke_oppgitt: {
    modell: "Innbyggeren har oppgitt at hun trenger rullestoladkomst, og kommunen har "
      + "ikke svart på om tilbudet har det. Det er ikke det samme som at det mangler.",
    standard: "har ikke oppgitt om det er rullestoladkomst"
  },
  mangler_rullestoladkomst: {
    modell: "Innbyggeren har oppgitt at hun trenger rullestoladkomst, og tilbudet har "
      + "det ikke. Derfor er tilbudet ikke med blant forslagene.",
    standard: "har ikke rullestoladkomst"
  },
  teleslynge: {
    modell: "Innbyggeren har oppgitt at hun har nytte av teleslynge, og tilbudet har det.",
    standard: "har teleslynge"
  },
  teleslynge_mangler: {
    modell: "Innbyggeren har oppgitt at hun har nytte av teleslynge, og tilbudet har det ikke.",
    standard: "har ikke teleslynge"
  },
  teleslynge_ikke_oppgitt: {
    modell: "Innbyggeren har oppgitt at hun har nytte av teleslynge, og kommunen har "
      + "ikke svart på om tilbudet har det.",
    standard: "har ikke oppgitt om det er teleslynge"
  },
  utenfor_kommunen: {
    modell: "Tilbudet ligger i en annen kommune enn den innbyggeren bor i.",
    standard: "ligger i en annen kommune"
  }
};

/** Så én treg modell ikke holder hele portalen. Resten får den deterministiske setningen. */
export const MAKS_TILBUD = 6;

/** En setning, ikke et avsnitt. Over dette har modellen sluttet å svare på spørsmålet. */
export const MAKS_TEGN = 240;

/**
 * Tilbudene slik de kom inn, renset.
 *
 * Kaster ikke på en ukjent kode - den slippes. `ai-gateway` skårer ikke selv og
 * har ingen mening om hvilke koder som finnes ut over kodeverket; en kode den
 * ikke kjenner er en tjeneste som er nyere enn den, og da er det riktige å skrive
 * setningen ut av det den forstår framfor å nekte å svare.
 */
export function parseTilbud(raa: unknown): Tilbudsinngang[] {
  if (!Array.isArray(raa)) return [];
  const rader: Tilbudsinngang[] = [];
  for (const post of raa) {
    if (!post || typeof post !== "object") continue;
    const rad = post as Record<string, unknown>;
    const tilbudId = String(rad.tilbudId ?? "").trim();
    const navn = String(rad.navn ?? "").trim();
    if (!tilbudId || !navn) continue;
    rader.push({
      tilbudId,
      navn,
      beskrivelse: String(rad.beskrivelse ?? "").trim(),
      begrunnelseskoder: (Array.isArray(rad.begrunnelseskoder) ? rad.begrunnelseskoder : [])
        .filter(erBegrunnelseskode)
    });
    if (rader.length === MAKS_TILBUD) break;
  }
  return rader;
}

/** «a», «a og b», «a, b og c». Egen funksjon fordi den siste og-en er lett å glemme. */
function ogListe(ledd: string[]): string {
  if (ledd.length <= 1) return ledd[0] ?? "";
  return `${ledd.slice(0, -1).join(", ")} og ${ledd[ledd.length - 1]}`;
}

/**
 * Setningen uten modellen.
 *
 * Dette er ikke en nødløsning å skamme seg over: det er teksten innbyggeren
 * faktisk får når `AI_PROVIDER=mock`, når modellen er nede, og hver gang svaret
 * ikke består sperrene. Den skal kunne stå alene.
 */
export function standardbegrunnelse(tilbud: Tilbudsinngang): string {
  const ledd = tilbud.begrunnelseskoder
    .map((kode) => KODEMENING[kode].standard)
    .filter((ledd): ledd is string => ledd !== null);
  if (ledd.length === 0) return "Dette er ett av tilbudene kommunen har.";
  return `Tilbudet ${ogListe(ledd)}.`;
}

const SPRAAKNAVN: Record<string, string> = {
  nb: "norsk bokmål",
  nn: "nynorsk",
  en: "engelsk"
};

export function byggBegrunnelsesprompt(tilbud: Tilbudsinngang, sprak = "nb"): string {
  const punkter = tilbud.begrunnelseskoder.map((kode) => `- ${KODEMENING[kode].modell}`);
  return [
    "Du skriver én setning til en innbygger over 62 år i en kommunal demosandkasse.",
    "",
    "Setningen skal si hvorfor tilbudet står i listen hennes, ut fra punktene under.",
    "Punktene er avgjort av en regel i koden, ikke av deg. Du rangerer ikke, og du",
    "avgjør ingenting.",
    "",
    "Krav til svaret:",
    `- Nøyaktig én setning på ${SPRAAKNAVN[sprak] ?? sprak}, høyst 25 ord.`,
    "- Snakk til innbyggeren som «du».",
    "- Bruk bare det som står under. Ikke finn på tidspunkt, sted, pris, telefonnummer",
    "  eller nettadresser, og ikke oppgi tall som ikke står i teksten.",
    "- Ikke si at hun har rett til noe, kvalifiserer til noe eller får noe innvilget.",
    "- Er et punkt negativt, si det rett ut framfor å pynte på det.",
    "- Svar med bare setningen. Ingen anførselstegn, ingen innledning, ingen punktliste.",
    "",
    `Tilbud: ${tilbud.navn}`,
    ...(tilbud.beskrivelse ? [`Om tilbudet: ${tilbud.beskrivelse}`] : []),
    "Punkter:",
    ...(punkter.length > 0 ? punkter : ["- Ingen særskilte punkter."])
  ].join("\n");
}

/** Sifrene i en tekst, som strenger. `kl. 14` og `14` er samme funn. */
function sifferrekker(tekst: string): string[] {
  return [...tekst.matchAll(/\d+/g)].map((treff) => treff[0]!);
}

export type Valideringsutfall =
  | { ok: true; tekst: string }
  | { ok: false; aarsak: string };

/**
 * Sperrene på veien ut.
 *
 * Tallregelen er strengere enn `findUngroundedNumbers` i sporsmaalsperrer.ts, og
 * det er med vilje: den er laget for et stort grunnlag der bare beløp er verdt å
 * måle, og den slipper igjennom bare tall under tusen. Her er inndataene korte
 * og kjente, så *hver* sifferrekke som ikke står i dem er noe modellen har funnet
 * på - og det farligste den kan finne på her er nettopp et lite tall: «tirsdager
 * klokken 14» sender et menneske til feil sted til feil tid.
 */
export function validerBegrunnelse(raa: unknown, tilbud: Tilbudsinngang): Valideringsutfall {
  const tekst = String(raa ?? "").replace(/\s+/g, " ").trim().replace(/^[«"']|[»"']$/g, "").trim();
  if (!tekst) return { ok: false, aarsak: "tomt svar" };
  if (tekst.length > MAKS_TEGN) {
    return { ok: false, aarsak: `svaret er ${tekst.length} tegn, grensen er ${MAKS_TEGN}` };
  }

  const kjenteSifre = new Set(sifferrekker(
    [tilbud.navn, tilbud.beskrivelse,
      ...tilbud.begrunnelseskoder.map((kode) => KODEMENING[kode].modell)].join(" ")
  ));
  const oppfunnet = sifferrekker(tekst).filter((siffer) => !kjenteSifre.has(siffer));
  if (oppfunnet.length > 0) {
    return { ok: false, aarsak: `oppgir tallet ${oppfunnet[0]}, som ikke står i grunnlaget` };
  }

  // En kontaktopplysning modellen har funnet på er verre enn ingen: den ser ut
  // som noe å ringe. Katalogens egne står på kortet, hentet fra data.
  if (/https?:\/\/|www\.|\S+@\S+\.\S+/i.test(tekst)) {
    return { ok: false, aarsak: "oppgir en nettadresse eller e-post" };
  }

  if (harBeslutningsspraak(tekst)) {
    return { ok: false, aarsak: "bruker beslutningsspråk" };
  }

  return { ok: true, tekst };
}

/** Én ferdig begrunnelse: modellens setning når den holder, ellers regelens. */
export function velgBegrunnelse(tilbud: Tilbudsinngang, modellsvar: unknown): Begrunnelse {
  const utfall = validerBegrunnelse(modellsvar, tilbud);
  if (utfall.ok) return { tilbudId: tilbud.tilbudId, tekst: utfall.tekst, kilde: "modell" };
  return {
    tilbudId: tilbud.tilbudId,
    tekst: standardbegrunnelse(tilbud),
    kilde: "regel",
    avvist: utfall.aarsak
  };
}
