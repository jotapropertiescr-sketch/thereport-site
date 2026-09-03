# Moving THE REPORT to GitHub, no terminal

Why this is necessary: Netlify only runs functions when they sit outside
the published site folder. A drag-and-drop deploy publishes everything you
drop, so the functions get served as text files instead of running. Connecting
a repository fixes that permanently, and it also means future updates deploy
themselves.

You will not install anything or type a command. Everything here happens in a
browser.

Set aside about 15 minutes.

---

## What changed in the folder

The files are now arranged the way Netlify needs:

```
thereport-site/
├── netlify.toml              <- tells Netlify how to build
├── public/                   <- everything the public sees
│   ├── index.html
│   ├── terms.html
│   └── (images, videos, sample PDFs)
└── netlify/
    └── functions/            <- code, deliberately outside public/
        ├── intake.js
        └── stripe-webhook.js
```

Do not rearrange these. The separation between `public/` and
`netlify/functions/` is the entire fix.

---

## Part 1 — Create a GitHub account

Skip if you have one.

1. Go to github.com and click **Sign up**
2. Use an email you check. Free plan is fine
3. Verify the email

---

## Part 2 — Create the repository

1. Once signed in, click the **+** in the top right, then **New repository**
2. Repository name: `thereport-site`
3. Select **Private**. Your site files are public on the web anyway, but
   there is no reason to publish the folder itself
4. Do not check any of the "initialize with" boxes
5. Click **Create repository**

You land on a mostly empty page with setup instructions. Ignore all of it.

---

## Part 3 — Upload the files

1. On that page, find the link **uploading an existing file**. If you do not
   see it, go to the **Add file** dropdown, then **Upload files**
2. Unzip the folder I sent you
3. Open the unzipped folder so you can see `netlify.toml`, `public`, and
   `netlify` inside it
4. Select all three items and drag them onto the GitHub upload area
5. Wait for the uploads to finish. The video file is the slowest
6. At the bottom, in the box that says "Commit changes", type: `initial site`
7. Click **Commit changes**

Confirm you now see `netlify.toml`, a `netlify` folder, and a `public`
folder in the repository. If `netlify.toml` is missing, upload it on its
own and commit again. Some browsers skip it because the name starts with a
word they treat oddly.

---

## Part 4 — Connect it to your existing Netlify site

Important: connect the **existing** project, do not create a new one. That
keeps jotapropertiescr.com pointed where it already is.

1. In Netlify, open your project (the URL shows
   `projects/imaginative-cassata-11ce54`)
2. Go to **Project configuration**
3. Find **Build & deploy**, then **Continuous deployment**
4. Click **Link repository** (it may read "Link to a Git repository")
5. Choose **GitHub**, authorize when asked, and select `thereport-site`
6. Netlify will ask for build settings. It should read them from
   `netlify.toml` automatically. Confirm they show:
   - Build command: empty
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
7. Click **Deploy**

---

## Part 5 — Confirm the functions exist

Wait for the deploy to finish, then go to **Logs & metrics → Functions**.

You should now see `intake` and `stripe-webhook` listed instead of the
"Build your first function" screen.

That is the whole point of this exercise. If they are listed, you are past
the blocker and back on the main path.

Also open jotapropertiescr.com and confirm the site still looks right.

---

## How you update the site from now on

You no longer drag anything to Netlify.

1. Go to your repository on GitHub
2. Open the `public` folder, click the file you want to replace
3. Click the pencil icon to edit text directly, or use **Add file → Upload
   files** to replace an image
4. Commit the change

Netlify redeploys on its own within a minute or two. If you break something,
GitHub keeps every prior version, so nothing is ever truly lost.

---

## What comes next

Back to the main walkthrough, Part 5 onward:

1. Add the three environment variables in Netlify
2. Create the Stripe webhook endpoint
3. Run a test order with card 4242 4242 4242 4242

---

## If you get stuck

Tell me which part number and what you see on screen. The two most common
snags are `netlify.toml` not uploading, and Netlify creating a second site
instead of linking the existing one. Both are quick to undo.
