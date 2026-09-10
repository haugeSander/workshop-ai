#!/usr/bin/env node

/*
 * Varslingsjobben, som CLI.
 *
 * Tynn med vilje: hele avgjørelsen ligger i `kjoerVarsling` i
 * apps/sandbox-backend/src/varsling.ts, og `POST /api/varsel/seniorsirkel/kjor`
 * er den andre inngangen til den samme funksjonen. To innganger, én
 * implementasjon - ellers driver de fra hverandre, og den ene sender til en
 * annen liste enn den andre.
 *
 * Retningen er også et krav: `scripts` er en sink i importgrafen
 * (`pnpm test:imports`), så modulen må bo i tjenesten og scriptet importere den.
 * Motsatt vei ville vært en syklus.
 *
 * Krever ikke at stakken er oppe for utvalget, men *sender* over HTTP til
 * fiks-simulatoren. Tørrkjøringen trenger derfor ingen tjenester i det hele tatt.
 *
 * Bruk:
 *   node scripts/varsle-seniorsirkel.ts --torrkjor
 *   node scripts/varsle-seniorsirkel.ts
 */

import { readState } from "../apps/sandbox-backend/src/state.ts";
import { kjoerVarsling } from "../apps/sandbox-backend/src/varsling.ts";
import { VARSELHJEMMEL } from "../apps/sandbox-backend/src/varsling.ts";
import { feilmelding } from "../apps/shared/errors.ts";

const torrkjoer = process.argv.includes("--torrkjor");

try {
  const tilstand = await readState();
  const resultat = await kjoerVarsling(tilstand, {
    sporingsId: `varsling-${Date.now()}`,
    torrkjoer
  });

  console.log(torrkjoer ? "Tørrkjøring - ingenting er sendt." : "Varsling kjørt.");
  console.log(`  Kommune:          ${resultat.kommunenummer}`);
  console.log(`  Grunnlag:         ${VARSELHJEMMEL.behandlingsgrunnlag}`);
  console.log(`                    ${VARSELHJEMMEL.suppleringsgrunnlag}`);
  console.log(`  Kandidater:       ${resultat.vurdert}`);
  console.log(`  Alt varslet før:  ${resultat.alleredeSendt}`);
  if (!torrkjoer) {
    for (const [kanal, antall] of Object.entries(resultat.perKanal).sort()) {
      console.log(`  ${kanal.padEnd(17)} ${antall}`);
    }
    if (resultat.feilet > 0) console.log(`  Feilet:           ${resultat.feilet}`);
  }
  for (const rad of resultat.utsendinger) {
    const hale = rad.grunn ? ` (${rad.grunn})` : "";
    console.log(`    ${rad.personId}  ${rad.status}${rad.kanal ? `  ${rad.kanal}` : ""}${hale}`);
  }
} catch (error) {
  console.error(`Varslingen stoppet: ${feilmelding(error)}`);
  process.exit(1);
}
