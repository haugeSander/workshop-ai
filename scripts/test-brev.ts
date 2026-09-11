#!/usr/bin/env node

/*
 * Brevinnholdet og PDF-en det blir til - rene funksjoner, uten stack og uten
 * modell, av samme grunn som test-personlig-brev.ts: byggBrevinnhold og
 * renderBrevPdf tar alt inn som parametere og gjør ingen fetch og ingen
 * state-I/O, så de kan pinnes mot en literal personfixture.
 *
 * Sendingen (sendBrev/sendBrevforsendelse) er ikke med her: den kaller Fiks-
 * simulatoren og hører hjemme i en kontrakttest med stacken oppe, ikke i en
 * fil som skal kjøre uten den.
 *
 * Bruk:
 *   node scripts/test-brev.ts
 */
import assert from "node:assert/strict";
import { brevnoekkel, byggBrevinnhold, renderBrevPdf } from "../apps/sandbox-backend/src/brev.ts";
import type { Person } from "../apps/shared/innbyggerdata.ts";

let sjekker = 0;
function sjekk(betingelse: unknown, melding: string): void {
  assert.ok(betingelse, melding);
  sjekker += 1;
}
function likt(faktisk: unknown, forventet: unknown, melding: string): void {
  assert.deepEqual(faktisk, forventet, melding);
  sjekker += 1;
}

const KJELL: Person = {
  personId: "person-402",
  husstandId: "household-212",
  syntetiskFodselsnummer: "01015812345",
  navn: { fornavn: "Kjell", mellomnavn: null, etternavn: "Bråten" },
  adressebeskyttelse: "UGRADERT",
  skjermet: false,
  bostedsadresse: {
    adressenavn: "Storgata",
    husnummer: 12,
    postnummer: "3510",
    poststed: "Hønefoss",
    kommunenummer: "3007",
    kommune: "Ringerike"
  }
};

const SKJERMET: Person = {
  ...KJELL,
  personId: "person-404",
  adressebeskyttelse: "STRENGT_FORTROLIG",
  skjermet: true
};

// --- byggBrevinnhold ---------------------------------------------------------

const aapningsinnhold = byggBrevinnhold({
  person: KJELL,
  brevtype: "aapning",
  kommunenavn: "Ringerike",
  avsnitt: ["Hei Kjell, hyggelig å høre fra deg."],
  punkter: ["Møteplasser og sosialt fellesskap", "Friluft og fysisk aktivitet"],
  telefon: "32 11 74 00",
  dato: "10.09.2026"
});
likt(aapningsinnhold.mottaker.navn, "Kjell Bråten", "mottakerens fulle navn settes sammen av navnefeltene");
likt(aapningsinnhold.mottaker.adresselinje1, "Storgata 12", "adresselinjen settes sammen av gatenavn og husnummer");
likt(aapningsinnhold.mottaker.postnummer, "3510", "postnummeret følger med");
likt(aapningsinnhold.mottaker.poststed, "Hønefoss", "poststedet følger med");
sjekk(
  aapningsinnhold.overskrift.includes("Bli med på aktiviteter"),
  "åpningsbrevet har den forventede overskriften"
);
likt(aapningsinnhold.avsnitt, ["Hei Kjell, hyggelig å høre fra deg."], "avsnittene gis videre uendret");
likt(aapningsinnhold.punkter.length, 2, "punktlisten gis videre uendret");
likt(aapningsinnhold.telefon, "32 11 74 00", "telefonnummeret gis videre uendret");
likt(aapningsinnhold.dato, "10.09.2026", "datoen gis videre uendret");

const oppfolgingsinnhold = byggBrevinnhold({
  person: KJELL,
  brevtype: "oppfolging",
  kommunenavn: "Ringerike",
  avsnitt: ["Hei igjen, Kjell."],
  punkter: [],
  telefon: "32 11 74 00",
  dato: "10.10.2026"
});
sjekk(
  oppfolgingsinnhold.overskrift !== aapningsinnhold.overskrift,
  "oppfølgingsbrevet har en annen overskrift enn åpningsbrevet"
);

/*
 * Skjerming er ikke noe brev.ts avgjør selv: postadresseFor (kvittering.ts) er
 * allerede skrevet for å svare tomt for en skjermet person, og brevet må aldri
 * omgå det ved å lese bostedsadresse på egen hånd.
 */
const skjermetInnhold = byggBrevinnhold({
  person: SKJERMET,
  brevtype: "aapning",
  kommunenavn: "Ringerike",
  avsnitt: ["Hei."],
  punkter: [],
  telefon: "32 11 74 00",
  dato: "10.09.2026"
});
likt(skjermetInnhold.mottaker.adresselinje1, undefined, "en skjermet person får ingen adresselinje i brevet");
likt(skjermetInnhold.mottaker.postnummer, undefined, "en skjermet person får ingen postnummer i brevet");

// --- brevnoekkel --------------------------------------------------------------

likt(brevnoekkel("person-402", "aapning"), "aapning:person-402", "nøkkelen er brevtype:personId");
sjekk(
  brevnoekkel("person-402", "aapning") !== brevnoekkel("person-402", "oppfolging"),
  "de to brevtypene for samme person gir ulik nøkkel"
);
sjekk(
  brevnoekkel("person-402", "aapning") !== brevnoekkel("person-403", "aapning"),
  "samme brevtype for to personer gir ulik nøkkel"
);

// --- renderBrevPdf -------------------------------------------------------------

const pdf = await renderBrevPdf(aapningsinnhold);
sjekk(Buffer.isBuffer(pdf), "renderBrevPdf gir en Buffer");
sjekk(pdf.length > 500, "PDF-en er ikke tom");
likt(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "bufferen starter med PDF-signaturen");

const tomPdf = await renderBrevPdf({ ...oppfolgingsinnhold, avsnitt: [], punkter: [] });
sjekk(Buffer.isBuffer(tomPdf) && tomPdf.length > 200, "renderBrevPdf takler et brev uten avsnitt eller punkter");

console.log(`test-brev ok. ${sjekker} sjekker, uten stack og uten modell.`);
