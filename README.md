# DARE store — setup

Everything here deploys to Vercel as-is: drag this folder into a Vercel project. No build step.

## What's in the folder
- `app.html` — the storefront (every page: shop, products, about, order status, confirmation)
- `products.json` — products, prices and stock
- `admin.html` — your dashboard for orders and stock, at `/admin`
- `api/` — the backend: checkout, Stripe webhook, stock, order lookup, welcome email, admin, per-page link previews, sitemap
- `images/` — product photos, icons, and the default link-preview image (`og.png`)
- `manifest.json` — lets phones add the site to the home screen like an app

## 1. Payments (Stripe) — required
1. Stripe > Developers > API keys > copy the **Secret key**.
2. Vercel > Project > Settings > Environment Variables: `STRIPE_SECRET_KEY`.
3. Stripe > Developers > Webhooks > Add endpoint: `https://YOUR-DOMAIN/api/stripe-webhook`
   Events: `checkout.session.completed` and `checkout.session.expired`. Copy the **Signing secret** into `STRIPE_WEBHOOK_SECRET`.
4. Stripe > Settings > Customer emails > turn on "Successful payments" (receipts).
5. Optional: turn on Stripe Tax, then set `STRIPE_AUTOMATIC_TAX` = `true`.
Test with card 4242 4242 4242 4242 while using a test key. (Needs a standard Stripe account — an Express-only account has no secret key.)

## 2. Stock + orders (Upstash Redis) — strongly recommended
1. Vercel > Project > Storage > Create > **Upstash Redis** (free tier is fine) > connect it to this project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
2. Set `ADMIN_PASSWORD` (8+ characters). Your dashboard is at `/admin`.
3. Set `SITE_URL` to your real domain, e.g. `https://dare.shop`.
Without Redis the store still sells, but it can't hold stock during checkout, log orders, run order lookup, or rate-limit abuse (see below).

How stock works: `stock` in products.json is the starting count per size. When someone starts checkout, their pieces are held for 30 minutes so two people can't buy the last one. Paid orders keep the hold; abandoned checkouts release it (via the webhook). Change counts any time from `/admin` > Stock. When a piece's total stock drops to 5 or fewer, a red "N left" badge appears on its tile and product page automatically — no setup needed.

## 3. Emails (Resend) — optional but recommended
Set `RESEND_API_KEY`, `FROM_EMAIL` (e.g. `DARE <orders@yourdomain.com>`, domain verified in Resend) and `OWNER_EMAIL` (you).
With this set: you get an email for every order, customers get a tracking email when you mark an order shipped in `/admin`, and new subscribers get an immediate welcome email with their discount code (see below). Without it, the store still works — those emails just don't send.

## 4. The 10% welcome discount
Both signup forms advertise "10% off" and show the code the moment someone joins.
1. Stripe > Product catalog > Coupons > create a coupon (10% off) > add a **promotion code** with the exact code `WELCOME10`.
2. That's it — checkout already has promo codes turned on, so customers can enter it at checkout.
To change the code or the percentage: update `CONFIG.welcomeCode` in `app.html`, the matching `WELCOME_CODE` constant at the top of `api/subscribe.js`, and the "10%" wording in the signup forms and the coupon in Stripe — all four need to match.

## 5. Email + SMS list (Klaviyo)
In `app.html`, CONFIG block: fill in `klaviyoPublicKey` and `klaviyoListId`.
Then in Klaviyo: finish SMS sender setup, add the Stripe integration, and build flows —
Welcome (list trigger), Abandoned cart (metric "Started Checkout"), Browse abandonment ("Viewed Product"), Post-purchase.
The Resend welcome email (above) covers the gap until your Klaviyo welcome flow is built.

## 6. Analytics — optional
In `app.html` CONFIG > `analytics`: add a GA4 ID and/or Meta Pixel ID, and set `vercel: true` after turning on Web Analytics in Vercel.
Page views, product views, add to bag, checkout starts, sign-ups and purchases are all sent automatically.

## 7. Products (`products.json`)
- `price` in dollars. Prices are always read on the server, so they can't be changed in the browser.
- `stock`: starting count per size, e.g. `{"S": 20, "M": 40}`. Sizes at 0 show as sold out. Every piece at 0 gets the red "Sold" dot.
- `image` / `imageBack`: e.g. `"/images/rare-tee-front.jpg"`. Until set, the site draws the garment.
- Tapping "Add to bag" again adds another of the same size — there's no quantity picker.
- Every piece shows a short reference code (like "HD-01") under its color and price instead of a name — generated automatically from its category and position in the file, so nothing to configure.

## 8. The brand story and the homepage feature
`app.html` CONFIG block:
- `storyHeading` ("D.A.R.E."), `storyExpansion` ("Desired Ambitions Required Execution") and `storyBody` — the story band under the hero. The About page has its own longer version — edit the `about()` function in `app.html` directly.
- `heroProductId` — pin the homepage's featured piece to one product's `id`. Leave it blank and the site picks the first in-stock piece for you.

## 9. Search + sharing
Every page has its own URL (`/p/tee-777`, `/about`, `/info/shipping`), title, description and share preview, plus product data Google understands (price, availability).
`/sitemap.xml` is generated automatically; submit it in Google Search Console.
Add real product photos to `image` so link previews show the piece instead of the default image.
The tab icon, home-screen icon, and manifest are already set up in `/images/` — replace `favicon-32.png`, `apple-touch-icon.png` and `icon-512.png` if you want a different mark than the "DA" one shipped here.

## Built-in abuse protection (no setup needed, works best with Redis)
- **Checkout**: capped at 20 attempts per 10 minutes per visitor, so someone can't hold your entire stock hostage by repeatedly starting checkouts and never paying.
- **Order status lookup**: capped at 20 tries per hour per visitor, so an order number can't be brute-forced.
- **Admin login**: 10 wrong passwords per 15 minutes locks out that visitor — the real password always keeps working from anywhere.
All three fail open if Redis isn't connected (the store keeps working), so Redis is what actually turns this protection on.

## Interactions (no setup needed)
Smooth page transitions (the piece's image travels into its page), red Sold dots and "N left" badges that appear live as stock changes, back view on hover, tap to zoom, "One by one" exhibition view (arrow keys or swipe), "View" cursor on desktop, and a sticky Add to bag bar on phones. All motion switches off for visitors who turn on reduced motion.

## Still needs you
Real photos, prices, stock counts, size charts, and social links (CONFIG), plus a review of the Privacy, Terms and Returns pages.
Shipping rates are in `api/checkout.js` (RATES). If you change the free-shipping threshold, change it there and in CONFIG.
