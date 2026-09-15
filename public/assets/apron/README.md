# Apron Production Asset Pack

This pack is designed for the Apron private-aviation ground-services platform.

## Rules

- Copy this folder to `public/assets/apron/` in the Next.js project.
- Use `lucide-react` for ordinary interface icons (search, settings, calendar, bell, chevrons, etc.).
- Use the custom SVGs in folders 02–04 for aviation/domain-specific concepts.
- Use the service and background WebP files for raster UI surfaces; keep SVG source files for future edits.
- Do not hotlink random third-party images in production.
- Location images in folder 07 are **generic fallbacks**. Never label one as KTEB/JFK/EWR/etc. unless it is actually a verified image of that location.
- Provider placeholder marks are intentionally generic. Real provider logos should be uploaded by the provider/admin and stored through the app's media pipeline.
- `10_misc/ui-reference.png` is the supplied visual north star, not an asset to render in the product.
- `10_misc/asset-pack-preview.png` is a visual inventory/preview only.

## Recommended app usage

- `01_brand`: app shell, auth, favicons.
- `02_service_icons`: service catalogue, chips, tables, request cards.
- `03_aviation_icons`: airport/FBO/flight/crew concepts.
- `04_ui_domain_icons`: operations-specific concepts that Lucide does not express well.
- `05_backgrounds`: client landing, login, sidebars, subtle patterns.
- `06_service_images`: provider service cards and marketing/empty-state surfaces.
- `07_location_placeholders`: only generic fallbacks when no verified real location image exists.
- `08_provider_placeholders`: company-logo fallback.
- `09_illustrations`: empty/success/error/security/global states.
- `10_misc`: avatars, abstract map, aircraft silhouette, reference images.

## Production image policy

If the product later uses real airport/FBO/provider photography, ingest licensed/owned media through an admin-managed media library and store attribution/license metadata. Keep remote vendor URLs out of UI components.
