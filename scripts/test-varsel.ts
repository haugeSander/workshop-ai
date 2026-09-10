#!/usr/bin/env node

/*
 * Kanalvalget for et varsel, som rene funksjoner.
 *
 * Hvorfor dette ikke ligger i test-forsendelse.ts: de to avgjørelsene ser like ut
 * og er det ikke. `chooseKanal` faller til PRINT, `velgVarselkanal` faller til
 * INGEN, og forskjellen er hele grunnen til at det er to funksjoner. En felles fil
 * ville invitert til en felles hjelpefunksjon, og da var skillet borte.
 *
 * Den bærende påstanden er den om reservasjon: en reservert innbygger får brev og
 * ikke SMS, så de to tabellene skal *ikke* stemme overens. Testen måler begge mot
 * de samme testpersonene, slik at «hvem får vedtaket» og «hvem blir minnet på»
 * står ved siden av hverandre og kan leses som to svar.
 *
 * Bruk:
 *   node scripts/test-varsel.ts
 */

import { readFile } from "node:fs/promises";
import {
  SMS_MAKSLENGDE,
  VARSELGRUNNER,
  VARSELKANALER,
  VARSELTYPER,
  validateVarsel,
  validateVarsellengde,
  velgVarselkanal
} from "../apps/fiks-simulator/src/varsel.ts";
import type { Varselgrunn } from "../apps/fiks-simulator/src/varsel.ts";
import { chooseKanal } from "../apps/fiks-simulator/src/forsendelse.ts";
import { maskBefolkning } from "../apps/shared/skjerming.ts";
import { alderVed } from "../apps/shared/alder.ts";

let bestatt = 0;
const feil: string[] = [];
function check(navn: string, betingelse: unknown, detalj = ""): void {
  if (betingelse) { bestatt += 1; return; }
  feil.push(`${navn}${detalj ? ` - ${detalj}` : ""}`);
}

const les = async (sti: string) => JSON.parse(await readFile(sti, "utf8"));

// --- 1. Kanalregelen, som fixturer ------------------------------------------

const TLF = { nummer: "+4799990001", sistOppdatert: "2026-01-01", sistVerifisert: "2026-01-01" };
const EPOST = { adresse: "en@example.test", sistOppdatert: "2026-01-01", sistVerifisert: "2026-01-01" };
const rad = (over: any = {}) =>
  ({ kanVarsles: true, reservert: false, tlf: TLF, epost: EPOST, ...over });

check("telefon gir SMS", velgVarselkanal(rad()).kanal === "SMS");
// SMS foran e-post: et varsel er kort og tidskritisk, og e-post er reserven.
check("e-post er reserven, ikke førstevalget",
  velgVarselkanal(rad({ tlf: undefined })).kanal === "EPOST");
check("uten begge er det ingen kanal",
  velgVarselkanal(rad({ tlf: undefined, epost: undefined })).kanal === "INGEN");

/*
 * Den bærende påstanden. Reservasjonen gjelder digital kommunikasjon fra det
 * offentlige, og et varsel er nettopp det - og det finnes ingen papirkanal å falle
 * til. Følgen er at en reservert innbygger ikke får påminnelser i det hele tatt,
 * selv om hun får vedtaket i posten.
 */
check("reservert stenger varselet helt",
  velgVarselkanal(rad({ reservert: true })).kanal === "INGEN");
check("og reservasjonen slår gjennom selv med telefon oppgitt",
  velgVarselkanal(rad({ reservert: true, kanVarsles: true })).kanal === "INGEN");

// Fire grunner og ikke én, fordi de fører til fire forskjellige handlinger.
for (const [navn, krrRad, ventet] of [
  ["ukjent i registeret", undefined, "ukjent_i_kontaktregisteret"],
  ["reservert", rad({ reservert: true }), "reservert"],
  ["kan ikke varsles", rad({ kanVarsles: false }), "kan_ikke_varsles"],
  ["rad uten kontaktopplysning", rad({ tlf: undefined, epost: undefined }),
    "ingen_kontaktopplysning"]
] as const) {
  const utfall = velgVarselkanal(krrRad as any);
  check(`grunnen navngis: ${navn}`,
    utfall.kanal === "INGEN" && utfall.grunn === ventet, JSON.stringify(utfall));
}
// Reservasjonen sjekkes før kanVarsles: begge gir INGEN, men grunnene er ikke
// utbyttbare - den ene er innbyggerens valg, den andre en tom kontaktrad.
check("reservasjonen navngis foran en tom kontaktrad",
  velgVarselkanal(rad({ reservert: true, kanVarsles: false })).grunn === "reservert");
check("en kanal som ikke er INGEN bærer ingen grunn",
  velgVarselkanal(rad()).grunn === undefined);

const settGrunner = new Set<Varselgrunn>(VARSELGRUNNER);
check("hver grunn i kodeverket nås av en gren",
  [...settGrunner].every((grunn) => [
    undefined, rad({ reservert: true }), rad({ kanVarsles: false }),
    rad({ tlf: undefined, epost: undefined })
  ].some((r) => velgVarselkanal(r as any).grunn === grunn)),
  VARSELGRUNNER.join(","));

// --- 2. De to tabellene skal ikke stemme overens ----------------------------

/*
 * Samme sju innbyggere, to avgjørelser. Testen finnes for at forskjellen skal være
 * synlig og tellet: `person-402` og `403` får brev og ikke varsel, og det er ikke
 * en feil i noen av dem.
 */
const raa = await les("data/personer.json");
const { personer } = maskBefolkning(raa, await les("data/husstander.json"));
const satser = await les("data/satser.json");
const krr = await les("data/krr.json");
const erSkjermet = (grad: string) =>
  grad === "STRENGT_FORTROLIG" || grad === "STRENGT_FORTROLIG_UTLAND" || grad === "FORTROLIG";

function mottakerFor(person: any) {
  const mottaker: any = { navn: "-", digitalId: person.syntetiskFodselsnummer };
  if (erSkjermet(person.adressebeskyttelse)) return mottaker;
  const adresse = person.bostedsadresse;
  if (!adresse?.adressenavn || !adresse.postnummer || !adresse.poststed) return mottaker;
  const husnummer = [adresse.husnummer, adresse.husbokstav].filter((del) => del != null).join("");
  return {
    ...mottaker,
    adresselinje1: [adresse.adressenavn, husnummer].filter(Boolean).join(" "),
    postnummer: String(adresse.postnummer),
    poststed: String(adresse.poststed)
  };
}

const kandidater = personer
  .filter((person: any) => person.bostedsadresse?.kommunenummer === "3305"
    && alderVed(person.foedselsdato, satser.gjelderFra) >= 62)
  .sort((a: any, b: any) => a.personId.localeCompare(b.personId));

check("sju kvalifiserer i Ringerike", kandidater.length === 7, String(kandidater.length));

const varseltelling: Record<string, number> = {};
const brevtelling: Record<string, number> = {};
for (const person of kandidater) {
  const krrRad = krr.find((r: any) => r.fnr === person.syntetiskFodselsnummer);
  const varsel = velgVarselkanal(krrRad);
  const brev = chooseKanal(mottakerFor(person), false, krrRad);
  varseltelling[varsel.kanal] = (varseltelling[varsel.kanal] ?? 0) + 1;
  const brevkanal = brev.lovlig ? brev.kanal : "AVVIST";
  brevtelling[brevkanal] = (brevtelling[brevkanal] ?? 0) + 1;
}
check("varsel: fire på SMS, tre uten kanal",
  varseltelling.SMS === 4 && varseltelling.INGEN === 3, JSON.stringify(varseltelling));
check("brev: fire digitalt, to på papir, én avvist",
  brevtelling.DIGITAL === 4 && brevtelling.PRINT === 2 && brevtelling.AVVIST === 1,
  JSON.stringify(brevtelling));

// person-402 er reservert og har postadresse: brev ja, varsel nei. Det er hele
// skillet mellom de to funksjonene, på én person.
const p402 = kandidater.find((p: any) => p.personId === "person-402");
const krr402 = krr.find((r: any) => r.fnr === p402?.syntetiskFodselsnummer);
check("person-402 får brev, men ikke varsel",
  (chooseKanal(mottakerFor(p402), false, krr402) as any).kanal === "PRINT"
  && velgVarselkanal(krr402).kanal === "INGEN");

// --- 3. Kroppen og SMS-lengden ----------------------------------------------

check("mottaker er påkrevd",
  validateVarsel({ tekst: "hei", type: "paaminnelse" })?.kode === "MANGLER_MOTTAKER");
check("tekst er påkrevd",
  validateVarsel({ digitalId: "1", type: "paaminnelse" })?.kode === "MANGLER_TEKST");
check("blanke tegn er ikke en tekst",
  validateVarsel({ digitalId: "1", tekst: "   ", type: "paaminnelse" })?.kode === "MANGLER_TEKST");
check("varseltypen må stå i kodeverket",
  validateVarsel({ digitalId: "1", tekst: "hei", type: "reklame" })?.kode === "UKJENT_VARSELTYPE");
for (const type of VARSELTYPER) {
  check(`${type} er en gyldig type`,
    validateVarsel({ digitalId: "1", tekst: "hei", type }) === null);
}

/*
 * Lengdegrensen håndheves på sendeflaten og ikke i prompten som skrev teksten. En
 * regel modellen blir bedt om å følge holder mesteparten av tiden; dette er stedet
 * den kan holdes hver gang.
 *
 * Og den måles mot kanalen, ikke mot kroppen: 200 tegn er feil for en SMS og helt i
 * orden for en e-post, og hvilken det blir vet vi først etter oppslaget i KRR.
 */
const langTekst = "a".repeat(SMS_MAKSLENGDE + 1);
check("en for lang SMS avvises",
  validateVarsellengde(langTekst, "SMS")?.kode === "FOR_LANG_SMS");
check("nøyaktig grensen går gjennom",
  validateVarsellengde("a".repeat(SMS_MAKSLENGDE), "SMS") === null);
check("den samme teksten er grei på e-post",
  validateVarsellengde(langTekst, "EPOST") === null);
check("og grei når det ikke blir noen kanal",
  validateVarsellengde(langTekst, "INGEN") === null);

check("kanalkodeverket har tre verdier",
  VARSELKANALER.length === 3 && VARSELKANALER.includes("INGEN"));

// --- report ----------------------------------------------------------------
if (feil.length > 0) {
  console.error(`test-varsel: ${feil.length} av ${bestatt + feil.length} sjekker feilet.`);
  for (const linje of feil) console.error(`  - ${linje}`);
  process.exit(1);
}
console.log(`test-varsel ok. ${bestatt} sjekker, uten stack og uten modell.`);
