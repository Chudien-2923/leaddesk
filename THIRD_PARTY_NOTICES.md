# Third-party notices

The root MIT license applies to original LeadDesk application code, documentation and original brand artwork. It does not replace the licenses or terms of third-party components, fonts, model artifacts or services. No third-party endorsement or exclusive trademark right is claimed.

## Transformers.js declaration patch

`patches/@huggingface+transformers+3.8.1.patch` modifies TypeScript declarations from Hugging Face Transformers.js3.8.1, licensed under Apache License2.0. The patch changes the base processor's batch/decoded type parameters and specializes the MGP-STR declarations so strict checking can remain enabled; it does not modify model inference behavior.

The applicable license is preserved in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt). Upstream: https://github.com/huggingface/transformers.js. The npm dependency is installed independently with its own notices/license.

## SVG icon geometry

The hand-authored icon adapter in `src/components/ui/Icon.tsx` uses common Feather/Lucide-style SVG geometry. Upstream attribution is retained conservatively for any derived path portions, rather than claiming every path is original artwork. Lucide's ISC license and the MIT notices for its Feather-derived icons are included in [licenses/Lucide-Feather.txt](licenses/Lucide-Feather.txt).

Upstream: https://github.com/lucide-icons/lucide and https://github.com/feathericons/feather. Their names and licenses do not imply endorsement.

## Outlined logo lettering

The LeadDesk SVG wordmark was created using outlined Geist glyphs; no font binary is bundled here. Geist is copyright2023 Vercel, in collaboration with basement.studio, and licensed under SIL Open Font License1.1. The upstream license is included for reference in [licenses/Geist-OFL.txt](licenses/Geist-OFL.txt). That license distinguishes Font Software from documents/artwork created with it; this repository does not relicense the font software as MIT.

Upstream: https://github.com/vercel/geist-font.

## Embedding model artifacts are not bundled

The preparation script downloads a pinned `Xenova/multilingual-e5-small` ONNX conversion of `intfloat/multilingual-e5-small`. The base model card declares MIT; the conversion and original model have their own upstream repositories and terms. No model files or previously downloaded cache are distributed in this source snapshot. Review those terms before downloading or redistributing weights:

- https://huggingface.co/Xenova/multilingual-e5-small
- https://huggingface.co/intfloat/multilingual-e5-small

## Other dependencies and external services

Dependencies listed in `package.json` / `package-lock.json` retain the licenses shipped by their authors. `node_modules` is not redistributed in Git. OMP, model-provider access, Supabase, HubSpot and Google Calendar are independently obtained services/software subject to their own licensing, authorization, usage and billing terms. The LeadDesk MIT license does not grant access to an account, API, subscription or model.
