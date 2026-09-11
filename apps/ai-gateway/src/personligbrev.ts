/*
 * De personlige avsnittene i et seniorsirkel-brev.
 *
 * **Modellen skriver bare avsnittene. Adresse, dato, punktlisten over
 * aktivitetskategorier og telefonfoten settes sammen av kode**, i
 * apps/sandbox-backend/src/brev.ts - akkurat som apps/shared/senioraktivitet.ts
 * sine katalogfelt aldri går gjennom en prompt. Samme arbeidsdeling som
 * tilbudsbegrunnelse.ts og personligsms.ts: modellen formulerer, den avgjør
 * ingenting og finner ikke på fakta koden allerede kjenner.
 *
 * Egen fil og ikke i server.ts, av samme grunn som de to andre: alt her er rene
 * funksjoner, og pnpm test:personlig-brev kjører dem uten stack og uten modell.
 */
import { harBeslutningsspraak } from "./sporsmaalsperrer.ts";
import { erBrevtype } from "../../shared/brev.ts";
import type { Brevtype } from "../../shared/brev.ts";

export type BrevForslag = { navn: string; kategori: string };
export type BrevHendelse = { navn: string; grunnlag: "paameldt" | "tilbud-nytt" };

/** Alt promptbyggeren og standardteksten trenger. Kjente fakta, ikke kallerens mening. */
export type BrevInngang = {
  fornavn: string;
  kommunenavn: string;
  telefon: string;
  brevtype: Brevtype;
  /** Brukt når brevtype er "aapning". Tom ellers. */
  forslag: BrevForslag[];
  /** Brukt når brevtype er "oppfolging". Tom ellers. */
  hendelser: BrevHendelse[];
};

export type PersonligBrev = {
  avsnitt: string[];
  /** `modell` når avsnittene kom fra modellen og besto sperrene, ellers `regel`. */
  kilde: "modell" | "regel";
  /** Hvorfor modellsvaret ble forkastet. Bare satt når `kilde` er `regel`. */
  avvist?: string;
};

/** Et brev, ikke en avhandling. Under dette er det ikke lenger et brev en kan lese ferdig i posten. */
export const MAKS_AVSNITT = 4;
export const MAKS_TEGN_TOTALT = 900;

function ogListe(ledd: string[]): string {
  if (ledd.length <= 1) return ledd[0] ?? "";
  return `${ledd.slice(0, -1).join(", ")} og ${ledd[ledd.length - 1]}`;
}

/** Teksten uten modellen. Det brevet faktisk får når AI_PROVIDER=mock, når modellen er nede, eller når svaret ikke består sperrene. */
export function standardPersonligBrev(inn: BrevInngang): string[] {
  if (inn.brevtype === "aapning") {
    const forslagnavn = inn.forslag.map((f) => f.navn);
    const om = forslagnavn.length > 0 ? ` som ${ogListe(forslagnavn)}` : "";
    return [
      `Hei ${inn.fornavn}. ${inn.kommunenavn} kommune har fått en innbyggerportal der du kan finne aktiviteter som passer deg.`,
      `Vi har blant annet tilbud${om} som vi tror kan være noe for deg.`,
      `Du kan melde deg på i portalen på nett, eller ringe oss på ${inn.telefon} hvis du heller vil ha det på papir.`
    ];
  }
  const hendelsesnavn = inn.hendelser.map((h) => h.navn);
  const om = hendelsesnavn.length > 0 ? ` ${ogListe(hendelsesnavn)}` : " aktivitetene dine";
  return [
    `Hei igjen, ${inn.fornavn}.`,
    `Vi vil fortelle deg litt om${om}, og om nye tilbud som har dukket opp for deg siden sist.`,
    `Ring oss gjerne på ${inn.telefon} hvis du lurer på noe.`
  ];
}

export function byggPersonligBrevPrompt(inn: BrevInngang, sprak = "nb"): string {
  const grunnlagslinjer = inn.brevtype === "aapning"
    ? (inn.forslag.length > 0
      ? inn.forslag.map((f) => `- ${f.navn} (${f.kategori})`)
      : ["- Ingen navngitte tilbud ennå - hold deg generell om mulighetene i kommunen."])
    : (inn.hendelser.length > 0
      ? inn.hendelser.map((h) => `- ${h.navn}: ${h.grunnlag === "paameldt" ? "hun er påmeldt" : "et nytt tilbud som passer henne"}`)
      : ["- Ingen hendelser å vise til - hold deg generell om oppfølgingen."]);

  return [
    "Du skriver de personlige avsnittene i et brev fra en norsk kommune til en",
    `innbygger over 62 år, i en kommunal demosandkasse, på ${sprak === "nb" ? "norsk bokmål" : sprak}.`,
    "",
    inn.brevtype === "aapning"
      ? "Dette er det første brevet: fortell om kommunens tilbud og hvorfor de kan passe akkurat henne."
      : "Dette er et oppfølgingsbrev: fortell om det hun allerede er med på, og om nytt som har dukket opp.",
    "",
    "Krav til svaret:",
    `- ${MAKS_AVSNITT - 1} til ${MAKS_AVSNITT} korte avsnitt, ett per linje.`,
    "- Snakk til innbyggeren som «du».",
    "- IKKE ta med telefonnummer, klokkeslett, priser eller andre tall, og ikke finn",
    "  på nettadresser. Koden legger til kontaktinformasjonen etterpå.",
    "- Ikke si at hun har rett til noe, kvalifiserer til noe eller får noe innvilget.",
    "- Svar med bare avsnittene, ett per linje. Ingen overskrift, ingen anførselstegn.",
    "",
    `Innbygger: ${inn.fornavn}`,
    `Kommune: ${inn.kommunenavn}`,
    "Grunnlag:",
    ...grunnlagslinjer
  ].join("\n");
}

function inneholderTallEllerLenke(tekst: string): boolean {
  return /\d/.test(tekst) || /https?:\/\/|www\.|\S+@\S+\.\S+/i.test(tekst);
}

export type Valideringsutfall =
  | { ok: true; avsnitt: string[] }
  | { ok: false; aarsak: string };

/** Sperrene på avsnittene, av samme grunn og med samme streng tallregel som personligsms.ts. */
export function validerPersonligBrev(raa: unknown): Valideringsutfall {
  const tekst = String(raa ?? "").trim();
  if (!tekst) return { ok: false, aarsak: "tomt svar" };
  const avsnitt = tekst.split(/\n+/).map((linje) => linje.trim()).filter(Boolean);
  if (avsnitt.length === 0) return { ok: false, aarsak: "tomt svar" };
  if (avsnitt.length > MAKS_AVSNITT) {
    return { ok: false, aarsak: `svaret har ${avsnitt.length} avsnitt, grensen er ${MAKS_AVSNITT}` };
  }
  const totalLengde = avsnitt.join(" ").length;
  if (totalLengde > MAKS_TEGN_TOTALT) {
    return { ok: false, aarsak: `svaret er ${totalLengde} tegn, grensen er ${MAKS_TEGN_TOTALT}` };
  }
  if (avsnitt.some(inneholderTallEllerLenke)) {
    return { ok: false, aarsak: "inneholder tall, lenke eller e-post - det skal koden legge til" };
  }
  if (avsnitt.some((linje) => harBeslutningsspraak(linje))) {
    return { ok: false, aarsak: "bruker beslutningsspråk" };
  }
  return { ok: true, avsnitt };
}

/** Ett ferdig sett avsnitt: modellens svar når det holder, ellers standardteksten. */
export function velgPersonligBrev(inn: BrevInngang, modellsvar: unknown): PersonligBrev {
  const utfall = validerPersonligBrev(modellsvar);
  if (utfall.ok) return { avsnitt: utfall.avsnitt, kilde: "modell" };
  return { avsnitt: standardPersonligBrev(inn), kilde: "regel", avvist: utfall.aarsak };
}

/**
 * Inngangen slik den kom over HTTP, renset.
 *
 * `null` når noe kjent mangler eller `brevtype` er ukjent - da er det opp til
 * ruten å svare med en advarsel, ikke å late som om noe kan skrives.
 */
export function parseBrevInngang(raa: unknown): BrevInngang | null {
  if (!raa || typeof raa !== "object") return null;
  const rad = raa as Record<string, unknown>;
  if (!erBrevtype(rad.brevtype)) return null;
  const fornavn = String(rad.fornavn ?? "").trim();
  const kommunenavn = String(rad.kommunenavn ?? "").trim();
  const telefon = String(rad.telefon ?? "").trim();
  if (!fornavn || !kommunenavn || !telefon) return null;
  const forslag = Array.isArray(rad.forslag)
    ? rad.forslag
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f) => ({ navn: String(f.navn ?? "").trim(), kategori: String(f.kategori ?? "").trim() }))
      .filter((f) => f.navn)
    : [];
  const hendelser = Array.isArray(rad.hendelser)
    ? rad.hendelser
      .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
      .map((h) => ({
        navn: String(h.navn ?? "").trim(),
        grunnlag: (h.grunnlag === "paameldt" ? "paameldt" : "tilbud-nytt") as "paameldt" | "tilbud-nytt"
      }))
      .filter((h) => h.navn)
    : [];
  return { fornavn, kommunenavn, telefon, brevtype: rad.brevtype, forslag, hendelser };
}
