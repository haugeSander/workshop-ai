/*
 * Den personlige åpningssetningen i en seniorsirkel-SMS.
 *
 * **Modellen skriver bare setningen som gjør teksten personlig. Den skriver
 * aldri lenken eller telefonnummeret.** Koden vet begge deler allerede - de er
 * ikke noe å finne på - og limer dem inn etterpå, i en fast setning. Det er
 * strengere enn tilbudsbegrunnelse.ts, som lar modellen gjengi tall den fant i
 * grunnlaget: her er det ingen legitim grunn til at åpningssetningen inneholder
 * et siffer, en lenke eller en e-post i det hele tatt, så validerBeslutning
 * forkaster dem alle i stedet for å måle dem mot et kjent sett.
 *
 * Egen fil og ikke i server.ts, av samme grunn som tilbudsbegrunnelse.ts: alt
 * her er rene funksjoner, og pnpm test:personlig-sms kjører dem uten stack og
 * uten modell.
 */
import { harBeslutningsspraak } from "./sporsmaalsperrer.ts";
import { SMS_MAKSLENGDE } from "../../shared/varsel.ts";

/**
 * Hvilken ramme SMS-en skrives i.
 *
 * `kunngjoring` kjenner ikke interessene hennes ennå - den inviterer bare inn.
 * `tilbud-forstegang` kommer rett etter at hun har samtykket, og peker på det
 * som skåret høyt. `tilbud-oppfolging` forutsetter at hun kjenner portalen fra
 * før, og forteller om noe nytt.
 */
export const SMS_RAMMER = ["kunngjoring", "tilbud-forstegang", "tilbud-oppfolging"] as const;
export type SmsRamme = (typeof SMS_RAMMER)[number];

export function erSmsRamme(verdi: unknown): verdi is SmsRamme {
  return typeof verdi === "string" && (SMS_RAMMER as readonly string[]).includes(verdi);
}

export type SmsForslag = { navn: string };

/** Alt promptbyggeren og standardteksten trenger. Kjente fakta, ikke kallerens mening. */
export type SmsInngang = {
  fornavn: string;
  kommunenavn: string;
  lenke: string;
  telefon: string;
  ramme: SmsRamme;
  forslag: SmsForslag[];
};

export type PersonligSms = {
  tekst: string;
  /** `modell` når åpningssetningen kom fra modellen og besto sperrene, ellers `regel`. */
  kilde: "modell" | "regel";
  /** Hvorfor modellsvaret ble forkastet. Bare satt når `kilde` er `regel`. */
  avvist?: string;
};

/**
 * Grensen for modellens egen setning.
 *
 * Ikke SMS_MAKSLENGDE selv: den ferdige teksten er åpningssetningen pluss en
 * fast, kjent hale (lenke eller telefonnummer), og halen tar plass. Grensen her
 * er satt så summen alltid har god margin til 160.
 */
export const MAKS_MODELLTEGN = 90;

const RAMMEBESKRIVELSE: Record<SmsRamme, string> = {
  kunngjoring:
    "Du inviterer innbyggeren til å sjekke ut kommunens nye innbyggerportal. Du "
    + "kjenner ikke interessene hennes ennå, så ikke gjett hva hun liker - vær varm "
    + "og nysgjerrig, ikke spesifikk.",
  "tilbud-forstegang":
    "Innbyggeren har nettopp sagt ja til å bli kontaktet om seniortilbud. Skriv en "
    + "setning som viser at dette er skrevet til akkurat henne, ut fra tilbudene under.",
  "tilbud-oppfolging":
    "Innbyggeren kjenner portalen fra før og kan ha meldt seg på noe tidligere. "
    + "Skriv en setning som viser at noe nytt har dukket opp for henne, ut fra tilbudene under."
};

/** Teksten uten modellen. Det innbyggeren faktisk får når AI_PROVIDER=mock, når modellen er nede, eller når svaret ikke består sperrene. */
export function standardPersonligSms(inn: SmsInngang): string {
  if (inn.ramme === "kunngjoring") {
    return `Hei ${inn.fornavn}! ${inn.kommunenavn} kommune har fått en innbyggerportal med tilbud for deg. Se ${inn.lenke}.`;
  }
  const forslagnavn = inn.forslag[0]?.navn;
  const om = forslagnavn ? ` som ${forslagnavn}` : "";
  return `Hei ${inn.fornavn}! Vi har tilbud${om} som kan passe deg. Meld deg på via ${inn.lenke}, eller ring ${inn.telefon}.`;
}

export function byggPersonligSmsPrompt(inn: SmsInngang, sprak = "nb"): string {
  const forslagslinjer = inn.forslag.length > 0
    ? inn.forslag.map((f) => `- ${f.navn}`)
    : ["- Ingen navngitte tilbud - hold deg generell."];
  return [
    "Du skriver den personlige åpningssetningen i en SMS fra en norsk kommune til en",
    `innbygger over 62 år, i en kommunal demosandkasse, på ${sprak === "nb" ? "norsk bokmål" : sprak}.`,
    "",
    RAMMEBESKRIVELSE[inn.ramme],
    "",
    "Krav til svaret:",
    "- Høyst én setning, varm og direkte, ikke administrativ.",
    "- Snakk til innbyggeren som «du», og bruk fornavnet hennes naturlig.",
    "- IKKE ta med lenke, telefonnummer, klokkeslett, pris eller andre tall. Koden",
    "  legger det til etterpå, i en egen setning.",
    "- Ikke si at hun har rett til noe, kvalifiserer til noe eller får noe innvilget.",
    "- Svar med bare setningen. Ingen anførselstegn, ingen innledning.",
    "",
    `Innbygger: ${inn.fornavn}`,
    `Kommune: ${inn.kommunenavn}`,
    "Aktuelle tilbud:",
    ...forslagslinjer
  ].join("\n");
}

function inneholderTallEllerLenke(tekst: string): boolean {
  return /\d/.test(tekst) || /https?:\/\/|www\.|\S+@\S+\.\S+/i.test(tekst);
}

export type Valideringsutfall =
  | { ok: true; tekst: string }
  | { ok: false; aarsak: string };

/**
 * Sperrene på åpningssetningen. Ingen sifferregel som slipper igjennom kjente
 * tall, slik tilbudsbegrunnelse.ts har: her finnes ingen legitime tall i det
 * hele tatt, siden lenken og telefonnummeret aldri skrives av modellen.
 */
export function validerPersonligSms(raa: unknown): Valideringsutfall {
  const tekst = String(raa ?? "").replace(/\s+/g, " ").trim().replace(/^[«"']|[»"']$/g, "").trim();
  if (!tekst) return { ok: false, aarsak: "tomt svar" };
  if (tekst.length > MAKS_MODELLTEGN) {
    return { ok: false, aarsak: `svaret er ${tekst.length} tegn, grensen er ${MAKS_MODELLTEGN}` };
  }
  if (inneholderTallEllerLenke(tekst)) {
    return { ok: false, aarsak: "inneholder tall, lenke eller e-post - det skal koden legge til" };
  }
  if (harBeslutningsspraak(tekst)) {
    return { ok: false, aarsak: "bruker beslutningsspråk" };
  }
  return { ok: true, tekst };
}

function byggHale(inn: SmsInngang): string {
  return inn.ramme === "kunngjoring"
    ? `Se ${inn.lenke}.`
    : `Meld deg på via ${inn.lenke}, eller ring ${inn.telefon}.`;
}

/** Én ferdig SMS: modellens åpning pluss den faste halen når den holder, ellers hele standardteksten. */
export function velgPersonligSms(inn: SmsInngang, modellsvar: unknown): PersonligSms {
  const utfall = validerPersonligSms(modellsvar);
  if (!utfall.ok) {
    return { tekst: standardPersonligSms(inn), kilde: "regel", avvist: utfall.aarsak };
  }
  const tekst = `${utfall.tekst} ${byggHale(inn)}`;
  if (tekst.length > SMS_MAKSLENGDE) {
    return {
      tekst: standardPersonligSms(inn),
      kilde: "regel",
      avvist: `sammensatt tekst ble ${tekst.length} tegn, grensen er ${SMS_MAKSLENGDE}`
    };
  }
  return { tekst, kilde: "modell" };
}

/**
 * Inngangen slik den kom over HTTP, renset.
 *
 * `null` når noe kjent mangler eller `ramme` er ukjent - da er det opp til
 * ruten å svare med en advarsel, ikke å late som om noe kan skrives.
 */
export function parseSmsInngang(raa: unknown): SmsInngang | null {
  if (!raa || typeof raa !== "object") return null;
  const rad = raa as Record<string, unknown>;
  if (!erSmsRamme(rad.ramme)) return null;
  const fornavn = String(rad.fornavn ?? "").trim();
  const kommunenavn = String(rad.kommunenavn ?? "").trim();
  const lenke = String(rad.lenke ?? "").trim();
  const telefon = String(rad.telefon ?? "").trim();
  if (!fornavn || !kommunenavn || !lenke || !telefon) return null;
  const forslag = Array.isArray(rad.forslag)
    ? rad.forslag
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f) => ({ navn: String(f.navn ?? "").trim() }))
      .filter((f) => f.navn)
    : [];
  return { fornavn, kommunenavn, lenke, telefon, ramme: rad.ramme, forslag };
}
