#!/usr/bin/env node

/*
 * Sperrene rundt den personlige åpningssetningen i en seniorsirkel-SMS.
 *
 * Rene funksjoner, uten stack og uten modell - som test-begrunnelse.ts, og av
 * samme grunn: dette er teksten en innbygger leser på telefonen sin, og en
 * sperre som bare finnes i prompten er en sperre som holder mesteparten av
 * tiden.
 *
 * Bruk:
 *   node scripts/test-personlig-sms.ts
 */
import assert from "node:assert/strict";
import { SMS_MAKSLENGDE } from "../apps/shared/varsel.ts";
import {
  MAKS_MODELLTEGN,
  SMS_RAMMER,
  byggPersonligSmsPrompt,
  erSmsRamme,
  parseSmsInngang,
  standardPersonligSms,
  validerPersonligSms,
  velgPersonligSms
} from "../apps/ai-gateway/src/personligsms.ts";
import type { SmsInngang } from "../apps/ai-gateway/src/personligsms.ts";

let sjekker = 0;
function sjekk(betingelse: unknown, melding: string): void {
  assert.ok(betingelse, melding);
  sjekker += 1;
}
function likt(faktisk: unknown, forventet: unknown, melding: string): void {
  assert.deepEqual(faktisk, forventet, melding);
  sjekker += 1;
}

const KUNNGJORING: SmsInngang = {
  fornavn: "Ingrid",
  kommunenavn: "Ringerike",
  lenke: "«min side» i innbyggerportalen",
  telefon: "32 11 74 00",
  ramme: "kunngjoring",
  forslag: []
};

const TILBUD: SmsInngang = {
  ...KUNNGJORING,
  ramme: "tilbud-forstegang",
  forslag: [{ navn: "Lavterskel turgruppe" }]
};

// --- inngangen -------------------------------------------------------------

for (const ramme of SMS_RAMMER) {
  sjekk(erSmsRamme(ramme), `${ramme} kjennes igjen som en ramme`);
}
sjekk(!erSmsRamme("Kunngjoring"), "rammesjekken er ikke slurvete med store bokstaver");
sjekk(!erSmsRamme("noe-annet"), "en ukjent ramme kjennes ikke igjen");

likt(parseSmsInngang(undefined), null, "ingen inngang gir null");
likt(parseSmsInngang({ ramme: "finnes-ikke" }), null, "en ukjent ramme gir null");
likt(
  parseSmsInngang({ ramme: "kunngjoring", fornavn: "Ingrid" }),
  null,
  "manglende kommunenavn/lenke/telefon gir null"
);
likt(
  parseSmsInngang({
    ramme: "tilbud-forstegang",
    fornavn: "Ingrid",
    kommunenavn: "Ringerike",
    lenke: "min side",
    telefon: "32 11 74 00",
    forslag: [{ navn: "Turgruppe" }, "ikke et objekt", { navn: "" }, 42]
  }),
  {
    fornavn: "Ingrid",
    kommunenavn: "Ringerike",
    lenke: "min side",
    telefon: "32 11 74 00",
    ramme: "tilbud-forstegang",
    forslag: [{ navn: "Turgruppe" }]
  },
  "forslag renses for rader uten et gyldig navn"
);

// --- prompten ---------------------------------------------------------------

const kunngjoringsprompt = byggPersonligSmsPrompt(KUNNGJORING);
sjekk(kunngjoringsprompt.includes(KUNNGJORING.fornavn), "prompten navngir innbyggeren");
sjekk(kunngjoringsprompt.includes(KUNNGJORING.kommunenavn), "prompten navngir kommunen");
sjekk(!kunngjoringsprompt.includes(KUNNGJORING.lenke), "kunngjøringsprompten nevner ikke lenken - koden legger den til");
sjekk(kunngjoringsprompt.includes("norsk bokmål"), "prompten navngir språket");
sjekk(/IKKE ta med lenke/.test(kunngjoringsprompt), "prompten forbyr modellen å skrive lenken selv");

const tilbudsprompt = byggPersonligSmsPrompt(TILBUD);
sjekk(tilbudsprompt.includes("Lavterskel turgruppe"), "prompten lister det navngitte tilbudet");
sjekk(/innvilget/.test(tilbudsprompt), "prompten forbyr vedtaksspråk");

const utenForslag = byggPersonligSmsPrompt({ ...TILBUD, forslag: [] });
sjekk(/hold deg generell/.test(utenForslag), "uten forslag ber prompten om å holde seg generell");

// --- den deterministiske teksten ---------------------------------------------

for (const ramme of SMS_RAMMER) {
  const tekst = standardPersonligSms({ ...KUNNGJORING, ramme, forslag: ramme === "kunngjoring" ? [] : TILBUD.forslag });
  sjekk(tekst.length <= SMS_MAKSLENGDE, `${ramme}: standardteksten holder seg innenfor ${SMS_MAKSLENGDE} tegn`);
  sjekk(tekst.includes(KUNNGJORING.fornavn), `${ramme}: standardteksten bruker fornavnet`);
}
sjekk(standardPersonligSms(KUNNGJORING).includes(KUNNGJORING.lenke), "kunngjøringens standardtekst nevner lenken");
sjekk(standardPersonligSms(TILBUD).includes(TILBUD.telefon), "tilbudsteksten nevner telefonnummeret");
sjekk(
  standardPersonligSms(TILBUD).includes(TILBUD.forslag[0]!.navn),
  "tilbudsteksten nevner det høyest skårede tilbudet"
);

// --- sperrene ----------------------------------------------------------------

function avvist(tekst: string): string {
  const utfall = validerPersonligSms(tekst);
  assert.equal(utfall.ok, false, `forventet at «${tekst}» ble avvist`);
  sjekker += 1;
  return (utfall as { ok: false; aarsak: string }).aarsak;
}
function godtatt(tekst: string): string {
  const utfall = validerPersonligSms(tekst);
  assert.equal(utfall.ok, true, `forventet at «${tekst}» ble godtatt`);
  sjekker += 1;
  return (utfall as { ok: true; tekst: string }).tekst;
}

godtatt("Vi har tenkt mye på deg i det siste og håper du har lyst til å bli med.");
likt(
  godtatt("  Hei   Ingrid,\nhyggelig å høre fra deg.  "),
  "Hei Ingrid, hyggelig å høre fra deg.",
  "linjeskift og dobbelt mellomrom klappes sammen"
);
likt(
  godtatt("«Hei Ingrid!»"),
  "Hei Ingrid!",
  "anførselstegn rundt hele svaret fjernes"
);

sjekk(avvist("").includes("tomt"), "et tomt svar avvises");
sjekk(avvist("a".repeat(MAKS_MODELLTEGN + 1)).includes("grensen"), "et for langt svar avvises");

/*
 * Ingen sifferregel som slipper igjennom kjente tall, i motsetning til
 * tilbudsbegrunnelse.ts: her har åpningssetningen ingen legitim grunn til å
 * inneholde et tall i det hele tatt, siden lenken og telefonnummeret aldri
 * skrives av modellen.
 */
sjekk(avvist("Vi ses klokken 14 i morgen!").includes("tall"), "et oppfunnet klokkeslett avvises");
sjekk(avvist("Ring 32 11 18 15 om du lurer på noe.").includes("tall"), "et oppfunnet telefonnummer avvises");
sjekk(avvist("Se www.eksempel.no for mer info.").length > 0, "en oppfunnet lenke avvises");
sjekk(
  avvist("Send en e-post til post@ringerike.kommune.no.").length > 0,
  "en oppfunnet e-postadresse avvises"
);
sjekk(
  avvist("Du har rett til å delta på dette tilbudet.").includes("beslutningsspråk"),
  "beslutningsspråk avvises"
);

// --- valget mellom de to -----------------------------------------------------

const fraModellKunngjoring = velgPersonligSms(KUNNGJORING, "Vi har en nyhet vi tror du vil sette pris på!");
likt(fraModellKunngjoring.kilde, "modell", "et gyldig svar kommer fra modellen");
likt(fraModellKunngjoring.avvist, undefined, "et gyldig svar har ingen avvisningsgrunn");
sjekk(fraModellKunngjoring.tekst.includes(KUNNGJORING.lenke), "den sammensatte teksten inneholder den kjente lenken");
sjekk(fraModellKunngjoring.tekst.length <= SMS_MAKSLENGDE, "den sammensatte teksten holder seg innenfor SMS-grensen");

const fraRegel = velgPersonligSms(TILBUD, "Turgruppen din møtes klokken 14 i morgen.");
likt(fraRegel.kilde, "regel", "et avvist svar faller tilbake på regelen");
likt(fraRegel.tekst, standardPersonligSms(TILBUD), "fallet er den deterministiske teksten");
sjekk(fraRegel.avvist?.includes("tall"), "avvisningsgrunnen sier hva som var galt");

likt(velgPersonligSms(KUNNGJORING, null).kilde, "regel", "et tomt modellsvar faller tilbake");
likt(velgPersonligSms(KUNNGJORING, undefined).kilde, "regel", "et manglende modellsvar faller tilbake");

/*
 * En åpningssetning som i seg selv er gyldig, men som sammen med halen
 * (lenken/telefonnummeret) sprenger SMS-grensen, skal falle tilbake på
 * regelen - ikke sende en SMS på over 160 tegn.
 */
const langAapning = "a".repeat(MAKS_MODELLTEGN);
sjekk(langAapning.length <= MAKS_MODELLTEGN, "test-fixturen alene består modelltegn-grensen");
const forLangtSammensatt = velgPersonligSms(TILBUD, langAapning);
likt(forLangtSammensatt.kilde, "regel", "en for lang sammensatt tekst faller tilbake på regelen");
sjekk(forLangtSammensatt.avvist?.includes("tegn"), "avvisningsgrunnen sier at den sammensatte teksten ble for lang");

console.log(`test-personlig-sms ok. ${sjekker} sjekker, uten stack og uten modell.`);
