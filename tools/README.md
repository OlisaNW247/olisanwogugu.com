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
