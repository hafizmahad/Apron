# Apron Asset Use Map

## Client-facing request experience
- Hero / request landing: `05_backgrounds/client-hero.webp`
- Brand: `01_brand/apron-logo-light.svg` on light surfaces, `apron-logo-dark.svg` on dark surfaces
- Service read-back chips: `02_service_icons/*.svg`
- Trust/support/global states: `09_illustrations/secure.svg`, `global-network.svg`

## Authentication
- Background: `05_backgrounds/login-auth.webp`
- Brand mark: `01_brand/apron-mark.svg`

## Operations Portal
- Sidebar atmosphere: `05_backgrounds/ops-sidebar.webp`
- Domain icons: `04_ui_domain_icons/operations.svg`, `assignment.svg`, `ai-research.svg`, `decision-trace.svg`, `sla-clock.svg`, `override.svg`, `audit.svg`
- Aviation concepts: `03_aviation_icons/*.svg`
- Service imagery only where it improves recognition; dense request details remain data-first.

## Service Provider Portal
- Sidebar atmosphere: `05_backgrounds/provider-sidebar.webp`
- Service cards: `06_service_images/*.webp`
- Service icons: `02_service_icons/*.svg`
- Resource/coverage/provider concepts: `04_ui_domain_icons/resource.svg`, `coverage.svg`, `provider-company.svg`

## Admin Console
- Sidebar atmosphere: `05_backgrounds/admin-sidebar.webp`, used subtly
- Admin is intentionally the least image-heavy portal.
- Provider fallback marks: `08_provider_placeholders/*.svg`
- Audit / coverage / provider domain icons: `04_ui_domain_icons/*.svg`

## Airport / FBO cards
- `07_location_placeholders/*.webp` are generic fallbacks only.
- Never associate a generic image with a named airport as if it were a verified photograph.
- Prefer structured airport/FBO identity + map + generic fallback until verified licensed media exists.

## States
- Empty: `09_illustrations/empty-state.svg`
- No data: `09_illustrations/no-data.svg`
- Success: `09_illustrations/success.svg`
- Error: `09_illustrations/error.svg`
- Security/privacy: `09_illustrations/secure.svg`
- Global network: `09_illustrations/global-network.svg`

## Generic UI icons
Use `lucide-react` for generic interface controls. Do not export dozens of duplicate generic SVGs into the repo.

## Rendering rules
- SVG domain icons use `currentColor`; style them from semantic design tokens.
- Prefer WebP for large raster backgrounds and service cards.
- Use `next/image` for raster assets.
- Create one typed asset registry in the application; do not scatter string paths across components.
