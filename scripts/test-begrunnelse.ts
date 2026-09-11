#!/usr/bin/env node

/*
 * Sperrene rundt setningen modellen skriver om et seniortilbud.
 *
 * Rene funksjoner, uten stack og uten modell - som test:sperrer, og av samme
 * grunn: dette er teksten en innbygger leser, og en sperre som bare finnes i
 * prompten er en sperre som holder mesteparten av tiden.
 *
 * Det testen faktisk måler, er at modellen ikke kan komme utenom skåringen. Den
 * kan formulere kodene, og den kan bli forkastet - den kan ikke legge til et
 * klokkeslett, et telefonnummer eller et vedtak.
 *
 * Bruk:
 *   node scripts/test-begrunnelse.ts
 */
import assert from "node:assert/strict";
import { BEGRUNNELSESKODER, erBegrunnelseskode } from "../apps/shared/begrunnelse.ts";
import {
  MAKS_TEGN,
  MAKS_TILBUD,
  byggBegrunnelsesprompt,
  parseTilbud,
  standardbegrunnelse,
  validerBegrunnelse,
  velgBegrunnelse
} from "../apps/ai-gateway/src/tilbudsbegrunnelse.ts";
import type { Tilbudsinngang } from "../apps/ai-gateway/src/tilbudsbegrunnelse.ts";

let sjekker = 0;
function sjekk(betingelse: unknown, melding: string): void {
  assert.ok(betingelse, melding);
  sjekker += 1;
}
function likt(faktisk: unknown, forventet: unknown, melding: string): void {
  assert.deepEqual(faktisk, forventet, melding);
  sjekker += 1;
}

const TURGRUPPE: Tilbudsinngang = {
  tilbudId: "dnt-ringerike-seniorgruppa",
  navn: "Lavterskel turgruppe",
  beskrivelse: "Rolige turer i nærmiljøet, med pauser underveis.",
  begrunnelseskoder: ["treffer_interesse", "i_maalgruppen", "mangler_rullestoladkomst"]
};

// --- inngangen -------------------------------------------------------------

likt(parseTilbud(undefined), [], "ingen tilbud gir ingen rader");
likt(parseTilbud("nei"), [], "en streng er ikke en liste");
likt(
  parseTilbud([{ tilbudId: "", navn: "Uten id", begrunnelseskoder: [] }]),
  [],
  "en rad uten tilbudId slippes"
);
likt(
  parseTilbud([{ tilbudId: "a", begrunnelseskoder: [] }]),
  [],
  "en rad uten navn slippes"
);

/*
 * En ukjent kode slippes framfor å gi 400. Gatewayen skårer ikke selv og har
 * ingen mening om hvilke koder som finnes ut over kodeverket: en kode den ikke
 * kjenner er en tjeneste som er nyere enn den.
 */
const medUkjent = parseTilbud([{
  tilbudId: "a", navn: "Et tilbud",
  begrunnelseskoder: ["treffer_interesse", "finnes_ikke", 42, null]
}]);
likt(medUkjent[0]?.begrunnelseskoder, ["treffer_interesse"], "ukjente koder slippes");

const forMange = parseTilbud(
  Array.from({ length: MAKS_TILBUD + 4 }, (_, i) => ({
    tilbudId: `t${i}`, navn: `Tilbud ${i}`, begrunnelseskoder: []
  }))
);
likt(forMange.length, MAKS_TILBUD, `høyst ${MAKS_TILBUD} tilbud slipper inn`);

for (const kode of BEGRUNNELSESKODER) {
  sjekk(erBegrunnelseskode(kode), `${kode} kjennes igjen som en kode`);
}
sjekk(!erBegrunnelseskode("treffer_Interesse"), "kodesjekken er ikke slurvete med store bokstaver");

// --- prompten --------------------------------------------------------------

const prompt = byggBegrunnelsesprompt(TURGRUPPE);
sjekk(prompt.includes(TURGRUPPE.navn), "prompten navngir tilbudet");
sjekk(prompt.includes(TURGRUPPE.beskrivelse), "prompten har beskrivelsen");
sjekk(prompt.includes("rullestoladkomst"), "prompten forklarer koden som utelukket tilbudet");
sjekk(prompt.includes("norsk bokmål"), "prompten navngir språket framfor å sende koden");
/*
 * ai-no-decisions, i prompten. Sperren i kode står i validerBegrunnelse og er
 * den som holder hver gang - men en prompt som ikke sier det, gjør sperren til
 * noe som slår inn ofte framfor sjelden.
 */
sjekk(/rangerer ikke/.test(prompt), "prompten sier at modellen ikke rangerer");
sjekk(/innvilget/.test(prompt), "prompten forbyr vedtaksspråk");

/*
 * Hver kode må ha en mening prompten kan bære. Uten denne kunne en ny kode i
 * kodeverket nå en innbygger som en tom kulepunktlinje.
 */
for (const kode of BEGRUNNELSESKODER) {
  const enkelt = byggBegrunnelsesprompt({
    tilbudId: "a", navn: "Et tilbud", beskrivelse: "", begrunnelseskoder: [kode]
  });
  const punkter = enkelt.split("Punkter:")[1] ?? "";
  sjekk(punkter.trim().length > 10, `${kode} har en mening prompten kan skrive ut av`);
}

// --- den deterministiske setningen ----------------------------------------

likt(
  standardbegrunnelse(TURGRUPPE),
  "Tilbudet passer med interessene du har valgt, er rettet mot din aldersgruppe og "
  + "har ikke rullestoladkomst.",
  "standardsetningen binder leddene med komma og «og»"
);
likt(
  standardbegrunnelse({ ...TURGRUPPE, begrunnelseskoder: ["treffer_interesse"] }),
  "Tilbudet passer med interessene du har valgt.",
  "ett ledd får ingen «og»"
);
/*
 * «Vi vet ikke» er ikke noe å skrive en setning om. Kodene finnes fordi ukjent
 * ikke er det samme som nei, men et kort som sier «vi vet ikke» er støy.
 */
likt(
  standardbegrunnelse({
    ...TURGRUPPE, begrunnelseskoder: ["utenfor_interessene", "maalgruppe_ukjent"]
  }),
  "Dette er ett av tilbudene kommunen har.",
  "koder uten noe å si gir en nøytral setning framfor en halv"
);
for (const kode of BEGRUNNELSESKODER) {
  const setning = standardbegrunnelse({ ...TURGRUPPE, begrunnelseskoder: [kode] });
  sjekk(setning.endsWith("."), `${kode} gir en setning som slutter med punktum`);
  sjekk(setning.length <= MAKS_TEGN, `${kode} gir en setning innenfor grensen`);
}

// --- sperrene --------------------------------------------------------------

function avvist(tekst: string): string {
  const utfall = validerBegrunnelse(tekst, TURGRUPPE);
  assert.equal(utfall.ok, false, `forventet at «${tekst}» ble avvist`);
  sjekker += 1;
  return (utfall as { ok: false; aarsak: string }).aarsak;
}
function godtatt(tekst: string): string {
  const utfall = validerBegrunnelse(tekst, TURGRUPPE);
  assert.equal(utfall.ok, true, `forventet at «${tekst}» ble godtatt`);
  sjekker += 1;
  return (utfall as { ok: true; tekst: string }).tekst;
}

godtatt("Turer i nærmiljøet passer godt med interessene dine, men gruppen har ikke rullestoladkomst.");
likt(
  godtatt("  Dette   passer\nmed interessene dine.  "),
  "Dette passer med interessene dine.",
  "linjeskift og dobbelt mellomrom klappes sammen"
);
likt(
  godtatt("«Dette passer med interessene dine.»"),
  "Dette passer med interessene dine.",
  "anførselstegn rundt hele svaret fjernes"
);

sjekk(avvist("").includes("tomt"), "et tomt svar avvises");
sjekk(avvist("   ").includes("tomt"), "bare mellomrom er tomt");
sjekk(avvist("a".repeat(MAKS_TEGN + 1)).includes("grensen"), "et for langt svar avvises");

/*
 * Tallet er den farligste feilen her, og den minst synlige. Ingenting i
 * inndataene sier når turen går, så et klokkeslett i svaret er funnet på - og et
 * oppfunnet klokkeslett sender et menneske til feil sted til feil tid.
 *
 * Merk at dette er strengere enn findUngroundedNumbers i sporsmaalsperrer.ts,
 * som slipper igjennom bare tall under tusen. Her ville den sluppet «klokken 14».
 */
sjekk(
  avvist("Turgruppen møtes tirsdager klokken 14 og passer med interessene dine.").includes("14"),
  "et oppfunnet klokkeslett avvises"
);
sjekk(
  avvist("Ring 32 11 18 15 for å høre om turgruppen.").includes("32"),
  "et oppfunnet telefonnummer avvises"
);
sjekk(
  avvist("Turen koster 300 kr.").includes("300"),
  "en oppfunnet pris avvises"
);
// Et tall som står i grunnlaget er ikke funnet på, og skal kunne gjentas.
likt(
  validerBegrunnelse("Gruppen passer for deg over 62 år.", {
    ...TURGRUPPE, beskrivelse: "Turgruppe for deg over 62 år."
  }).ok,
  true,
  "et tall som står i beskrivelsen slipper igjennom"
);

sjekk(
  avvist("Les mer på https://dntringerike.no om turgruppen.").includes("nettadresse"),
  "en oppfunnet nettadresse avvises"
);
sjekk(
  avvist("Send en e-post til post@dntringerike.no om turgruppen.").includes("nettadresse"),
  "en oppfunnet e-postadresse avvises"
);
sjekk(
  avvist("Du har rett til å delta i turgruppen.").includes("beslutningsspråk"),
  "beslutningsspråk avvises"
);
sjekk(
  avvist("Du oppfyller vilkårene for dette tilbudet.").includes("beslutningsspråk"),
  "vilkårsspråk avvises"
);
// Sperren folder æ, ø og å, så «avslår» og «avslar» er samme mønster.
sjekk(
  avvist("Vi avslår denne påmeldingen.").includes("beslutningsspråk"),
  "beslutningsspråk med norske bokstaver avvises"
);

// --- valget mellom de to ---------------------------------------------------

const fraModell = velgBegrunnelse(TURGRUPPE, "Turene passer med interessene dine, men gruppen mangler rullestoladkomst.");
likt(fraModell.kilde, "modell", "et gyldig svar kommer fra modellen");
likt(fraModell.avvist, undefined, "et gyldig svar har ingen avvisningsgrunn");
likt(fraModell.tilbudId, TURGRUPPE.tilbudId, "raden bærer tilbudId-en sin");

const fraRegel = velgBegrunnelse(TURGRUPPE, "Turgruppen går tirsdager klokken 14.");
likt(fraRegel.kilde, "regel", "et avvist svar faller tilbake på regelen");
likt(fraRegel.tekst, standardbegrunnelse(TURGRUPPE), "fallet er den deterministiske setningen");
sjekk(fraRegel.avvist?.includes("14"), "avvisningsgrunnen sier hva som var galt");

likt(velgBegrunnelse(TURGRUPPE, null).kilde, "regel", "et tomt modellsvar faller tilbake");
likt(velgBegrunnelse(TURGRUPPE, undefined).kilde, "regel", "et manglende modellsvar faller tilbake");

console.log(`test-begrunnelse ok. ${sjekker} sjekker, uten stack og uten modell.`);
