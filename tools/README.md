# Apple Music → the site

Two scripts run from the same GitHub Action (`.github/workflows/now-playing.yml`), every five minutes:

- `tools/update-now-playing.mjs` writes `now-playing.json`, the song behind the headphones icon.
- `tools/update-radio.mjs` writes `radio.json`, the station behind the radio icon (see **Olisa's radio** below).

# Now playing: Apple Music → now-playing.json

`now-playing.json` at the root of the site is what the "Olisa is listening to" reveal reads.
The GitHub Action in `.github/workflows/now-playing.yml` keeps it fresh by asking Apple Music
for the most recently played track every five minutes and committing the file when it changes.

## One-time setup

1. **Create a MusicKit key.** Apple Developer portal → Certificates, Identifiers & Profiles → Keys →
   "+" → enable **MusicKit** → download the `.p8` file (it can only be downloaded once). Note the
   **Key ID** on that page and your **Team ID** (Membership details).
2. **Get a Music User Token.** Open `https://olisanwogugu.com/tools/authorize.html`, paste the Team ID,
   Key ID and the `.p8` contents, click **Sign in with Apple Music** and sign in. Copy the token it shows.
   Nothing on that page is sent anywhere except to Apple's sign-in.
3. **Add four repository secrets.** GitHub → repo → Settings → Secrets and variables → Actions:

   | Secret | Value |
   | --- | --- |
   | `APPLE_TEAM_ID` | your Team ID |
   | `APPLE_KEY_ID` | the Key ID |
   | `APPLE_PRIVATE_KEY` | the full `.p8` contents, including the BEGIN/END lines |
   | `APPLE_MUSIC_USER_TOKEN` | the token from step 2 |

4. **Run it once by hand.** GitHub → Actions → "Update now playing" → Run workflow. A green run means
   it worked; the commit it makes will say which song it found.

## Things to know

- The Music User Token lasts roughly six months. When the Action starts failing with a 403, repeat
  step 2 and update that one secret.
- Apple's "recently played" list updates once a song has been playing for a bit, and the Action polls
  every five minutes, so the site trails real life by a few minutes.
- GitHub pauses scheduled workflows on repositories with no commits for 60 days. Any commit re-enables it.
- If the site stops redeploying after the bot's commits, create a fine-grained personal access token with
  **Contents: Read and write** on this repository and save it as a `PUSH_TOKEN` secret. The workflow
  uses it automatically when present.

# Olisa's radio

`radio.html` is a synchronized 24/7 station. Everyone tuned in hears the same song at the same moment,
because the page computes the position from the station's start time rather than streaming.

**How the station is chosen.** Every run, the Action takes the last song Olisa played and finds the
playlists with more than 10 songs that contain it. The one with the most songs wins; a tie goes to the
playlist Olisa opened most recently. If no playlist qualifies (an album play, say), the station stays as
it is. When the winning playlist changes, `radio.json` is rewritten with a fresh start time and a
seeded shuffle of the playlist's catalog songs.

**Files.**

| File | What it is |
| --- | --- |
| `radio.json` | the station: playlist name, start time, shuffled tracks with art, duration, preview and link |
| `radio-index.json` | cache of every library playlist's track ids, refreshed when Apple reports a change or once a day |
| `radio-token.json` | developer token for Apple's web player, renewed when under 30 days remain |

**Listening.** The page opens on a split screen: Apple Music on one half, Spotify on the other.

- *Apple Music*: sign in with an Apple Music subscription and hear full songs through Apple's web
  player (MusicKit JS). No subscription → falls back to Apple's 30-second previews.
- *Spotify*: opens Spotify's embedded player beneath the cover. Listeners logged in to Spotify in
  their browser hear full songs; everyone else hears Spotify's 30-second previews, and the clock
  switches to 30-second slots so they stay in step with each other.
- A small link under the halves plays Apple's previews with no sign-in at all.

Songs that exist only in the library with no catalog match are skipped. Songs with no Spotify match
are silent for Spotify listeners during that slot, so everyone stays in sync.

## Spotify

With a Spotify Premium account the developer dashboard allows Web API access, which gives the radio
its best Spotify setup: exact song matching through Spotify's own catalog, a real sign-in, and full
songs in our own player for Premium listeners.

**Setup (once).**

1. At <https://developer.spotify.com/dashboard> create an app. Add `https://olisanwogugu.com/radio.html`
   as a Redirect URI, tick **Web API** and **Web Playback SDK**, and save.
2. In the app's Settings copy the Client ID and Client secret, and add them as repository secrets
   `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
3. Under the app's **User Management** add the Spotify account email of each person who should be able
   to sign in. New Spotify apps stay in *development mode*, which allows up to 25 such users. Anyone
   else who signs in is dropped to Spotify's embedded player automatically.
4. Run the workflow once. It matches the station through Spotify's catalog (ISRC first, then a
   title-and-artist search), up to 150 songs a run, and publishes the client id in `radio-token.json`
   for the browser sign-in.

**How listeners experience it.** Tapping Spotify sends them to Spotify's sign-in page in the same
tab (a script-driven navigation, which iOS does not hand to the Spotify app), then back to the radio,
where one tap starts full songs in sync with everyone else. Premium is Spotify's requirement for
playback in a third-party player. Without Premium, or without the app configured, listeners get
Spotify's embedded player instead: full songs if logged in to Spotify in that browser, previews
otherwise.

**Without the app.** Matching falls back to Odesli (if `ODESLI_API_KEY` is set) and MusicBrainz, which
together cover only a fraction of most playlists.
