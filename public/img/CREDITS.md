# Photograph credits and licences

Every image here is **public domain** — a work of the United States federal
government, which carries no copyright. None requires a licence fee, permission,
or attribution, and none becomes a problem if this repository goes public or the
site is ever monetised.

Credit is given anyway. It costs nothing and it is the same rule the rest of the
project follows: say where a thing came from.

Licences were checked individually against Wikimedia Commons' machine-readable
metadata rather than trusting a stock site's blanket claim. Stock libraries that
permit free commercial use (Unsplash, Pexels) were considered and passed over:
they carry no indemnification and no model releases, and a government work has
neither problem.

| File | Subject | Source | Licence |
|---|---|---|---|
| `hero-cotton.jpg` | Cotton harvester cutting rows, **Batesville, Texas** | USDA, via Wikimedia Commons | Public domain |
| `crop-standing.jpg` | Corn tassels against a summer sky, Warren County, Indiana | Huw Williams, via Wikimedia Commons | Public domain |
| `wx-drought.jpg` | Burnt corn on cracked ground, **Texas**, 20 Aug 2013 | USDA, photo by Bob Nichols | Public domain |

## Where they are used

- **Hero** — `hero-cotton.jpg`, full width, under the masthead. No caption is
  printed: the work is public domain and requires no attribution, and a credit
  line on a decorative photograph is furniture rather than information.
- **Season tracker cover** — `crop-standing.jpg` and `wx-drought.jpg` split down
  the middle, with a water mark on the seam. The same crop standing and burnt:
  one field, two outcomes, and the thing that decides between them.
- **Similar years cover** — no photograph. It is a drawn figure of six season
  cards with one pulled out, because the subject of that panel is the
  *comparison*, and nothing photographic can say "we looked through thirty years
  and this one matches".

## Why these

Two of the three were taken in Texas, which matters for a Texas tool — a generic
stock field would have been easier to find and would have said nothing true
about the place. The corn-tassels frame is from Indiana; no comparable
public-domain Texas equivalent was found, and a standing corn crop reads
correctly regardless of the state line. Replacing it with a Texas frame would be
an improvement, not a fix.

Using the **same crop** on both sides of the season split is deliberate. Two
different crops would have read as two different fields; corn standing beside
corn burnt reads as one field and two seasons, which is what the panel is about.

**CHECK IMAGES BY LOOKING AT THEM.** Every wrong candidate rejected during this
work had a caption that sounded right: an "irrigated field" that was a close-up
of a person working on a pipe, a "cotton field" that was a drowned crop standing
in storm water, a "lush" contour farm that was mostly harvested stubble. Two
images that had already SHIPPED were replaced on inspection as well — an aerial
cotton texture standing in for "a standing crop" (it reads as brown corduroy at
thumbnail size) and a drought photograph of young corn on dry ground that read as
a healthy young crop.

## Removed, and how to get them back

Four images were used briefly for a four-photograph "similar years" cover and are
no longer referenced. They are deleted rather than left to rot, but the exact
Commons filenames are recorded here so any of them can be restored precisely:

| Was | Commons file | Licence |
|---|---|---|
| `crop-water.jpg` | `Cotton Harvest at Schirmer Farms, TX (20200823-NRCS-LSC-0937).jpg` | Public domain |
| `wx-rain.jpg` | `Irrigation and Water (20210603-NRCS-LSC-0480).jpg` | Public domain |
| `wx-sun.jpg` | `Cotton harvesting at sunset with light orange sky in Batesville, Texas cotton field.jpg` | Public domain |
| `wx-harvest.jpg` | `Corn combine harvest with grain cart-2.jpg` | CC0 |

## If you add or replace one

Keep to public-domain government imagery (USDA ARS, USDA NRCS, NASA, NOAA) or
CC0, and verify the licence yourself on Wikimedia Commons. Fetch at roughly the
displayed size using Commons' own thumbnail renderer rather than re-encoding
locally — it does a better job than a hand-rolled resize and it is one fewer step
to get wrong.

**Two traps in that fetch.** Commons renders a PNG source as a PNG thumbnail no
matter what extension is requested, so a photograph can silently arrive as a
230 KB PNG named `.jpg`; check the magic bytes and re-encode. And aerial crop
rows are high-frequency detail that JPEG compresses badly, so check the file size
rather than assuming a small pixel count means a small file.

**Commons keyword search is poor for this.** Categories and bulk-upload filename
prefixes found everything the free-text queries missed — a single USDA photo
shoot uploaded in bulk shares a filename prefix, which is a far better handle
than any phrase.

---

## Author photographs (`people/`)

Headshots of the three authors, downloaded on 30 September 2026 — Pulkit's
from his own website, the other two from their Texas A&M profile pages — cropped to the face and reduced to 192 px square JPEGs so
the footer stays light. They are used with the authors' knowledge as the
people credited on the site; the originals remain the property of their
owners.

| File | Person | Source |
|---|---|---|
| `people/juneja.jpg` | Pulkit Juneja | https://pulkitjuneja-23.github.io/assets/img/headshot.jpg (his own site) |
| `people/baath.jpg` | Gurjinder S. Baath | https://blackland.tamu.edu/media/1skgrxgo/baath_50.jpg (Digital Agriculture Lab page, https://blackland.tamu.edu/dalab/ — chosen by the authors on 1 October 2026 over his profile-page headshot) |
| `people/burke.jpg` | Joseph A. Burke | https://agrilifepeople.tamu.edu/img/pictures/26669.png (AgriLife People directory) |

Dr. Baath's AgriLife People entry has no photograph — its image URL returns an
HTML page — which is why his comes from the research centre's site instead.
