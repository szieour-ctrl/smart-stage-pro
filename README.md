# Smart Stage PRO™

**AI-Powered Virtual Staging for Sacramento Real Estate Teams**

Powered by Smart Stage AI™ · Built by SZ Real Estate Group · DRE #01397303

\---

## Deploy Your Brokerage Instance

Click the button below to deploy your own branded Smart Stage PRO™ instance to Netlify.
You will be prompted to enter your brokerage credentials during setup.

[!\[Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/szieour-ctrl/smart-stage-pro)

> \\\\\\\*\\\\\\\*Note for Sam:\\\\\\\*\\\\\\\* Replace `szieour-ctrl` in the URL above with your actual GitHub username after pushing this repo.

\---

## Required Environment Variables

After clicking Deploy, Netlify will ask you to configure these variables:

### Agent / Brokerage Branding

|Variable|Description|Example|
|-|-|-|
|`AGENT\\\\\\\_NAME`|Licensed agent's full name|`Sam Zieour`|
|`AGENT\\\\\\\_BROKERAGE`|Brokerage name|`SZ Real Estate Group`|
|`AGENT\\\\\\\_DRE`|DRE license number|`01397303`|
|`AGENT\\\\\\\_LOGO\\\\\\\_URL`|URL to brokerage logo (PNG/JPG, hosted publicly)|`https://...`|

### AI APIs

|Variable|Description|Where to get it|
|-|-|-|
|`ANTHROPIC\\\\\\\_API\\\\\\\_KEY`|Claude Vision API key|console.anthropic.com|
|`OPENAI\\\\\\\_API\\\\\\\_KEY`|GPT Image API key|platform.openai.com|
|`DECOR8\\\\\\\_API\\\\\\\_KEY`|Decor8 staging API key|app.decor8.ai|

### Image Storage

|Variable|Description|Where to get it|
|-|-|-|
|`CLOUDINARY\\\\\\\_CLOUD\\\\\\\_NAME`|Your Cloudinary cloud name|console.cloudinary.com|
|`CLOUDINARY\\\\\\\_API\\\\\\\_KEY`|Cloudinary API key|console.cloudinary.com|
|`CLOUDINARY\\\\\\\_API\\\\\\\_SECRET`|Cloudinary API secret|console.cloudinary.com|
|`IMGBB\\\\\\\_API\\\\\\\_KEY`|ImgBB API key (temporary staging)|api.imgbb.com|

### Property Search

|Variable|Description|Where to get it|
|-|-|-|
|`GOOGLE\\\\\\\_MAPS\\\\\\\_API\\\\\\\_KEY`|Google Places Autocomplete API key|console.cloud.google.com|

### Netlify Infrastructure (set after first deploy)

|Variable|Description|Where to get it|
|-|-|-|
|`NETLIFY\\\\\\\_ACCESS\\\\\\\_TOKEN`|Personal access token for Blobs|app.netlify.com → User Settings → Applications|
|`NETLIFY\\\\\\\_SITE\\\\\\\_ID`|Your site's unique ID|app.netlify.com → Site Settings → General|

\---

## California AB 723 Compliance

Smart Stage PRO™ automatically generates compliance pages for every property project.

* Every staged image includes a QR code linking to the property's compliance page
* Compliance pages show original + staged image pairs side-by-side
* Pages are maintained for 3 years (California DRE record retention requirement)
* ZIP download available for all project images
* Satisfies California Business and Professions Code §10140.8 (AB 723, effective October 10, 2025)

\---

## MetroList MLS Compliance

* All staged images include the Smart Stage AI™ watermark
* Side-by-side before/after composite download included
* Satisfies MetroList Rule 11.6.1 disclosure requirements

\---

## Support

Contact Smart Stage AI™ at smart-stage-ai.netlify.app

*Smart Stage PRO™ is licensed software. Unauthorized redistribution is prohibited.*

