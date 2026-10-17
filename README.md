# CRYP Mining

A browser based mining game backed by Firebase Authentication and Cloud Firestore.

## Hourly Podium

The Podium shows up to ten players ranked by:

`cash balance + CRYP balance × current CRYP exchange rate`

A scheduled Cloud Function recalculates the snapshot every hour from the private `players/{uid}` documents and the shared `market/exchangeRate` document. It publishes only `rank`, `nickname`, `cashBalance`, and `totalCapital` for each listed player, plus the snapshot's `updatedAt` timestamp. The public document is `podium/current`; clients can read it while signed in, but cannot write it.

The browser never reads other players' private save documents. Firestore rules allow each signed-in player to access only their own `players/{uid}` document. The game continues to update the shared market using its existing authenticated client transaction.

## Firebase setup

1. Compare `firestore.rules` with the rules currently deployed in Firebase Console. The file covers the collections used by this repository. Merge any rules for other project collections before deploying, since deploying these rules replaces the database's current ruleset.
2. Use the Firebase project configured in `.firebaserc` (`cryp-togame`) or update that alias to the intended project.
3. Scheduled Cloud Functions require the Blaze plan and Cloud Scheduler. Review the project's billing and enable the Cloud Scheduler API before deployment.
4. Install function dependencies with `npm --prefix functions install`.
5. Deploy the rules and scheduled function with `firebase deploy --only firestore:rules,functions:updatePodiumHourly`.

The first podium snapshot appears after the first successful scheduled run. The web app displays its last update time and shows an empty-state message until then.

## Data and trust limits

The scheduler keeps private account fields and CRYP balances out of the public document. The game currently saves balances from the browser, so a player can alter their own local game state before it is saved. The server-generated ranking prevents a client from writing public ranking entries, but it cannot make client-generated balances tamper-proof. A tamper-proof economy would require moving game balance changes to trusted server code.

The scheduled job reads the player collection once per hour and costs scale with the number of player documents.
