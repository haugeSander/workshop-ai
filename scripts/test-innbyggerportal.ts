import assert from "node:assert/strict";
import { norskKalenderdato } from "../apps/shared/alder.ts";
import {
  hentAktivitetskatalog,
  hentPortaltilbud
} from "../apps/sandbox-backend/src/innbyggerportal.ts";

assert.equal(
  norskKalenderdato(Date.parse("2025-12-31T23:30:00Z")),
  "2026-01-01",
  "Portalen skal bruke norsk kalenderdato"
);

const offentligKatalog = hentAktivitetskatalog();
assert.equal(offentligKatalog.kommunenavn, "Ringerike");
assert.equal(offentligKatalog.kommunenummer, "3305");
assert.ok(offentligKatalog.aktiviteter.length > 0);
assert.ok(offentligKatalog.tilbydere.length > 0);
assert.equal(offentligKatalog.mock, true);
assert.equal(offentligKatalog.syntetisk, true);

const foerTerskel = hentPortaltilbud("1964-09-11", "3305", "2026-09-10");
assert.equal(foerTerskel.portalTilgjengelig, false);
assert.deepEqual(foerTerskel.aktiviteter, []);
assert.deepEqual(foerTerskel.tilbydere, []);

const fra62 = hentPortaltilbud("1964-09-10", "3305", "2026-09-10");
assert.equal(fra62.portalTilgjengelig, true);
assert.equal(fra62.kommunenavn, "Ringerike");
assert.equal(fra62.kommunenummer, "3305");
assert.ok(fra62.aktiviteter.length > 0);
assert.ok(fra62.tilbydere.length > 0);
assert.equal(fra62.schemaVersjon, 1);

const aktivitet = fra62.aktiviteter.find((kandidat) => kandidat.aktivitetId === "matombringing");
assert.ok(aktivitet);
assert.ok(aktivitet.maalgrupper.some((maalgruppe) => maalgruppe.alder?.fraAar !== undefined));

const tilbud = aktivitet.tilbud.find(
  (kandidat) => kandidat.tilbudId === "matombringing-ringerikskjokken"
);
assert.ok(tilbud);
assert.ok(fra62.tilbydere.some((tilbyder) => tilbyder.tilbyderId === tilbud.tilbyderId));

const annenKommune = hentPortaltilbud("1964-09-10", "0301", "2026-09-10");
assert.equal(annenKommune.portalTilgjengelig, false);
assert.deepEqual(annenKommune.aktiviteter, []);

console.log("Innbyggerportalens aldersgrense og aktivitetskatalog er verifisert.");