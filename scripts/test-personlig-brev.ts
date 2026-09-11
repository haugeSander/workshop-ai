#!/usr/bin/env node

/*
 * Sperrene rundt de personlige avsnittene i et seniorsirkel-brev.
 *
 * Rene funksjoner, uten stack og uten modell - som test-personlig-sms.ts, og
 * av samme grunn: dette er teksten som havner i et brev en innbygger leser,
 * og en sperre som bare finnes i prompten er en sperre som holder mesteparten
 * av tiden.
 *
 * Bruk:
 *   node scripts/test-personlig-brev.ts
 */
import assert from "node:assert/strict";
import { BREVTYPER, erBrevtype } from "../apps/shared/brev.ts";
import {
  MAKS_AVSNITT,
  MAKS_TEGN_TOTALT,
  byggPersonligBrevPrompt,
  parseBrevInngang,
  standardPersonligBrev,
  validerPersonligBrev,
  velgPersonligBrev
} from "../apps/ai-gateway/src/personligbrev.ts";
import type { BrevInngang } from "../apps/ai-gateway/src/personligbrev.ts";

let sjekker = 0;
function sjekk(betingelse: unknown, melding: string): void {
  assert.ok(betingelse, melding);
  sjekker += 1;
}
function likt(faktisk: unknown, forventet: unknown, melding: string): void {
  assert.deepEqual(faktisk, forventet, melding);
  sjekker += 1;
}

const AAPNING: BrevInngang = {
  fornavn: "Kjell",
  kommunenavn: "Ringerike",
  telefon: "32 11 74 00",
  brevtype: "aapning",
  forslag: [{ navn: "Lavterskel turgruppe", kategori: "friluft-og-fysisk-aktivitet" }],
  hendelser: []
};

const OPPFOLGING: BrevInngang = {
  ...AAPNING,
  brevtype: "oppfolging",
  forslag: [],
  hendelser: [{ navn: "Lavterskel turgruppe", grunnlag: "paameldt" }]
};

// --- inngangen ---------------------------------------------------------------

for (const brevtype of BREVTYPER) {
  sjekk(erBrevtype(brevtype), `${brevtype} kjennes igjen som en brevtype`);
}
sjekk(!erBrevtype("Aapning"), "brevtypesjekken er ikke slurvete med store bokstaver");
sjekk(!erBrevtype("avslutning"), "en ukjent brevtype kjennes ikke igjen");

likt(parseBrevInngang(undefined), null, "ingen inngang gir null");
likt(parseBrevInngang({ brevtype: "midt-i-mellom" }), null, "en ukjent brevtype gir null");
likt(
  parseBrevInngang({ brevtype: "aapning", fornavn: "Kjell" }),
  null,
  "manglende kommunenavn/telefon gir null"
);
likt(
  parseBrevInngang({
    brevtype: "aapning",
    fornavn: "Kjell",
    kommunenavn: "Ringerike",
    telefon: "32 11 74 00",
    forslag: [{ navn: "Turgruppe", kategori: "friluft" }, "ikke et objekt", { navn: "" }, 42],
    hendelser: "ikke en liste"
  }),
  {
    fornavn: "Kjell",
    kommunenavn: "Ringerike",
    telefon: "32 11 74 00",
    brevtype: "aapning",
    forslag: [{ navn: "Turgruppe", kategori: "friluft" }],
    hendelser: []
  },
  "forslag renses for rader uten et gyldig navn, hendelser uten en liste blir tom"
);
likt(
  parseBrevInngang({
    brevtype: "oppfolging",
    fornavn: "Kjell",
    kommunenavn: "Ringerike",
    telefon: "32 11 74 00",
    hendelser: [{ navn: "Turgruppe", grunnlag: "noe-ukjent" }]
  })?.hendelser,
  [{ navn: "Turgruppe", grunnlag: "tilbud-nytt" }],
  "en ukjent grunnlagsverdi faller til tilbud-nytt framfor å kastes"
);

// --- prompten ------------------------------------------------------------------

const aapningsprompt = byggPersonligBrevPrompt(AAPNING);
sjekk(aapningsprompt.includes(AAPNING.fornavn), "prompten navngir innbyggeren");
sjekk(aapningsprompt.includes(AAPNING.kommunenavn), "prompten navngir kommunen");
sjekk(aapningsprompt.includes("Lavterskel turgruppe"), "prompten lister det navngitte tilbudet");
sjekk(!aapningsprompt.includes(AAPNING.telefon), "prompten nevner ikke telefonnummeret - koden legger det til");
sjekk(/norsk bokmål/.test(aapningsprompt), "prompten navngir språket");
sjekk(/IKKE ta med telefonnummer/.test(aapningsprompt), "prompten forbyr modellen å skrive kontaktinfo selv");
sjekk(/innvilget/.test(aapningsprompt), "prompten forbyr vedtaksspråk");

const oppfolgingsprompt = byggPersonligBrevPrompt(OPPFOLGING);
sjekk(oppfolgingsprompt.includes("hun er påmeldt"), "oppfølgingsprompten sier hva hendelsen betyr");
sjekk(oppfolgingsprompt !== aapningsprompt, "de to brevtypene gir ulik prompt");

const utenGrunnlag = byggPersonligBrevPrompt({ ...AAPNING, forslag: [] });
sjekk(/hold deg generell/.test(utenGrunnlag), "uten grunnlag ber prompten om å holde seg generell");

// --- den deterministiske teksten ------------------------------------------------

for (const brevtype of BREVTYPER) {
  const avsnitt = standardPersonligBrev({ ...AAPNING, brevtype });
  sjekk(avsnitt.length > 0, `${brevtype}: standardteksten har minst ett avsnitt`);
  sjekk(
    avsnitt.join(" ").length <= MAKS_TEGN_TOTALT,
    `${brevtype}: standardteksten holder seg innenfor ${MAKS_TEGN_TOTALT} tegn`
  );
  sjekk(avsnitt.some((linje) => linje.includes(AAPNING.fornavn)), `${brevtype}: standardteksten bruker fornavnet`);
}
sjekk(
  standardPersonligBrev(AAPNING).some((linje) => linje.includes("Lavterskel turgruppe")),
  "åpningsbrevets standardtekst nevner det navngitte tilbudet"
);
sjekk(
  standardPersonligBrev(OPPFOLGING).some((linje) => linje.includes("Lavterskel turgruppe")),
  "oppfølgingsbrevets standardtekst nevner hendelsen"
);
sjekk(
  standardPersonligBrev(AAPNING).some((linje) => linje.includes(AAPNING.telefon)),
  "standardteksten nevner telefonnummeret"
);

// --- sperrene --------------------------------------------------------------

function avvist(tekst: string): string {
  const utfall = validerPersonligBrev(tekst);
  assert.equal(utfall.ok, false, `forventet at «${tekst}» ble avvist`);
  sjekker += 1;
  return (utfall as { ok: false; aarsak: string }).aarsak;
}
function godtatt(tekst: string): string[] {
  const utfall = validerPersonligBrev(tekst);
  assert.equal(utfall.ok, true, `forventet at «${tekst}» ble godtatt`);
  sjekker += 1;
  return (utfall as { ok: true; avsnitt: string[] }).avsnitt;
}

likt(
  godtatt("Hei Kjell, hyggelig å høre fra deg.\nVi håper du har det bra."),
  ["Hei Kjell, hyggelig å høre fra deg.", "Vi håper du har det bra."],
  "hvert linjeskift blir et eget avsnitt"
);
likt(
  godtatt("  Ett samlet avsnitt uten linjeskift.  "),
  ["Ett samlet avsnitt uten linjeskift."],
  "et svar uten linjeskift blir ett avsnitt"
);

sjekk(avvist("").includes("tomt"), "et tomt svar avvises");
sjekk(avvist("   \n  \n ").includes("tomt"), "bare mellomrom og linjeskift er tomt");
sjekk(
  avvist(Array.from({ length: MAKS_AVSNITT + 1 }, () => "Et avsnitt uten tall.").join("\n")).includes("avsnitt"),
  "flere avsnitt enn grensen avvises, og sier hvor mange"
);
sjekk(
  avvist("a".repeat(MAKS_TEGN_TOTALT + 1)).includes("tegn"),
  "et for langt samlet svar avvises"
);

sjekk(avvist("Vi ses klokken 14 hos oss.").includes("tall"), "et oppfunnet klokkeslett avvises");
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
sjekk(
  avvist("Hei Kjell.\nDu oppfyller vilkårene for dette tilbudet.").includes("beslutningsspråk"),
  "beslutningsspråk i ett av flere avsnitt avvises"
);

// --- valget mellom de to -----------------------------------------------------

const fraModell = velgPersonligBrev(AAPNING, "Vi har tenkt mye på deg.\nHåper du har lyst til å bli med.");
likt(fraModell.kilde, "modell", "et gyldig svar kommer fra modellen");
likt(fraModell.avvist, undefined, "et gyldig svar har ingen avvisningsgrunn");
likt(fraModell.avsnitt.length, 2, "avsnittene bevares som de kom inn");

const fraRegel = velgPersonligBrev(OPPFOLGING, "Turgruppen din møtes klokken 14 i morgen.");
likt(fraRegel.kilde, "regel", "et avvist svar faller tilbake på regelen");
likt(fraRegel.avsnitt, standardPersonligBrev(OPPFOLGING), "fallet er de deterministiske avsnittene");
sjekk(fraRegel.avvist?.includes("tall"), "avvisningsgrunnen sier hva som var galt");

likt(velgPersonligBrev(AAPNING, null).kilde, "regel", "et tomt modellsvar faller tilbake");
likt(velgPersonligBrev(AAPNING, undefined).kilde, "regel", "et manglende modellsvar faller tilbake");

console.log(`test-personlig-brev ok. ${sjekker} sjekker, uten stack og uten modell.`);
