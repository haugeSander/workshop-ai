/*
 * Kodeverkene for et varsel: den korte beskjeden til en innbygger.
 *
 * Her og ikke i fiks-simulator, fordi to tjenester leser dem. Fiks avgjør kanalen
 * og validerer kroppen; sandbox-backend bygger varselet og fører det i ledgeren
 * sin. Én av dem kunne eid listene og den andre kopiert dem - og da hadde en ny
 * varseltype vært to endringer, hvorav den ene kunne glemmes uten at noe ble rødt.
 *
 * Selve *avgjørelsen* blir igjen i fiks (`velgVarselkanal`): kanalen leses av
 * kontakt- og reservasjonsregisteret, og det registeret er Fiks-siden. Det er bare
 * ordene som bor her.
 */

/**
 * Kanalene et varsel kan gå på.
 *
 * **Ingen papirkanal, og det er ikke en forglemmelse.** `Forsendelsesstatus` og
 * `chooseKanal` i fiks-simulator gjelder et dokument - vedtaket, kvitteringen - og
 * faller til `PRINT`, fordi et brev tåler tre dager. En påminnelse gjør ikke det:
 * «husk turen på tirsdag» i posten kommer etter turen, og et varsel ingen kan lese
 * i tide er verre enn ingen varsel, fordi det ser sendt ut i loggen.
 *
 * `INGEN` er derfor et utfall og ikke en feil.
 */
export const VARSELKANALER = ["SMS", "EPOST", "INGEN"] as const;
export type Varselkanal = (typeof VARSELKANALER)[number];

/**
 * Hva varselet er.
 *
 * Typen avgjør ikke kanalen i dag, men den står i loggen, og det er poenget:
 * «hvem fikk et uanmodet varsel om et tilbud» og «hvem ble minnet på noe hun selv
 * meldte seg på» er to spørsmål med to hjemler, og en logg som ikke skiller dem
 * kan ikke svare på noen av dem.
 *
 * `paamelding-bekreftet` er den tredje varianten: den er *bedt om*. Innbyggeren
 * meldte seg nettopp på, og bekreftelsen er en del av tjenesten hun ba om - ikke
 * en henvendelse vi tok initiativ til.
 *
 * `portal-kunngjoring` er en fjerde: den nevner ikke noe tilbud i det hele tatt,
 * bare at portalen finnes. Den kan ikke dele hjemmel med `tilbud-finnes`, som
 * loggen leser som «et konkret tilbud ble vurdert for henne» - kunngjøringen har
 * ikke vurdert noe ennå.
 */
export const VARSELTYPER = [
  "tilbud-finnes",
  "paamelding-bekreftet",
  "paaminnelse",
  "avlysning",
  "portal-kunngjoring"
] as const;
export type Varseltype = (typeof VARSELTYPER)[number];

/**
 * Hvorfor et varsel ikke kunne sendes.
 *
 * Fire grunner og ikke én, fordi de fører til fire forskjellige handlinger: en
 * ukjent i registeret er en datafeil hos oss, en reservert er et valg innbyggeren
 * har tatt og skal respekteres, «kan ikke varsles» er en tom kontaktrad, og
 * `ingen_kontaktopplysning` er en rad som sier at hun kan varsles uten å oppgi noe
 * å varsle på - en selvmotsigelse i registeret.
 */
export const VARSELGRUNNER = [
  "ukjent_i_kontaktregisteret",
  "reservert",
  "kan_ikke_varsles",
  "ingen_kontaktopplysning"
] as const;
export type Varselgrunn = (typeof VARSELGRUNNER)[number];

/** Ein SMS er 160 tegn i GSM-7. Lengre tekst maa gaa paa e-post. */
export const SMS_MAKSLENGDE = 160;
