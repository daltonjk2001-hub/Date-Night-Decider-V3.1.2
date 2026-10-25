DATE NIGHT DECIDER V3.1.2 — FIXED FILE SET

Included replacement files:
- index.html
- app.js
- styles.css
- manifest.json
- service-worker.js

What was repaired:
1. Restored styles.css, which had been replaced by plain-text notes and was not valid app CSS.
2. Kept exactly two primary modes: Matcher and Surprise. History, Library, and Store remain secondary tools accessed through Settings.
3. Added explicit pack selection. The Starter Collection is selected by default; locked expansion packs are disabled until a demo unlock. Newly unlocked packs are automatically selected, and the user can choose which unlocked packs Matcher and Surprise use.
4. Added six built-in ideas so all nine categories have starter content (18 starter ideas total).
5. Filled all five expansion packs with seven distinct cards each (35 pack cards total) and wired them to the previews/unlock state.
6. Matcher now uses mutual likes only. One mutual option goes directly to the winner; two or more open the elimination draft; zero shows a no-match screen with retry and filter-adjustment actions. No unrelated suggestions are inserted.
7. Fixed peer-to-peer messages for a single mutual winner, no-mutual outcome, starting the mutual draft, restarting after no matches, and asking the host to change filters.
8. Fixed secondary-tool shortcuts so they do not incorrectly use the Matcher tab as the navigation control.
9. Added backup persistence for selected packs, and retained compatibility with older backups that lack the selectedPacks field.
10. Bumped the service-worker cache namespace and asset query versions to 3.1.2-fix1 so the stylesheet/script changes are fetched after deployment. The visible app version remains V3.1.2.

Deployment:
1. Replace the five same-named files in the GitHub Pages repository with these versions.
2. Keep existing icon-192.png and icon-512.png files in the repository; they are referenced by the manifest but were not part of the uploaded five-file source set.
3. Commit/push the changes and load the deployed page again. If an installed PWA still shows an old UI, fully close and reopen it after the new service worker activates.

Validation performed:
- JavaScript syntax checks passed for app.js and service-worker.js.
- Manifest JSON parsed successfully.
- HTML parsed; IDs are unique; exactly two primary navigation tabs remain.
- All 53 built-in/expansion cards pass the app card sanitizer and have unique IDs.
- Each of the five store packs has exactly seven cards.
- Scripted logic checks passed for default pack contents, selecting an expansion, no-mutual UI, mutual draft creation, single-winner/no-match P2P messages, and utility-view routing.

Limitations:
- These are code-level and scripted tests in a mocked DOM, not a full live-browser or two-physical-device PeerJS network test.
- The expansion store is still a local demo. Displayed prices do not collect payments or grant server-verified purchases.
- Live multiplayer still depends on the PeerJS signaling service and available network traversal; this update does not add a TURN relay.