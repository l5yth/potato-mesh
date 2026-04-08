# About This Mesh

Welcome to this [PotatoMesh](https://github.com/l5yth/potato-mesh) instance - a community dashboard for off-grid mesh networks. This is an example page, please modify it before deploying.

## What Is Meshtastic?

[Meshtastic](https://meshtastic.org) is an open-source project that turns
affordable LoRa radios into a decentralised, long-range communication network.
No cellular service or internet connection is required - nodes relay messages
across the mesh automatically.

## What Is Meshcore?

[Meshcore](https://meshcore.co.uk) is a firmware for LoRa radios focused on
reliable, low-power mesh networking. It provides a public channel system and
supports narrow-band presets optimised for long range in dense environments.

## Network Details

| Setting   | Meshtastic      | Meshcore          |
| --------- | --------------- | ----------------- |
| Channel   | #MediumFast     | Public            |
| Frequency | 869.525 MHz     | 869.618 MHz       |
| Bandwidth | 250 kHz         | 62.5 kHz          |
| SF        | 8               | 8                 |
| CR        | 4/5             | 4/8               |
| Preset    | Medium / Fast   | EU/UK Narrow      |

> Adjust this table to match the configuration of your local mesh.

## Contact

- **Public chat:** [#potatomesh:dod.ngo](https://matrix.to/#/#potatomesh:dod.ngo)
- **Source code:** [github.com/l5yth/potato-mesh](https://github.com/l5yth/potato-mesh)

## Custom Pages

Instance operators can add, edit, or remove pages by placing Markdown files in
the `pages/` directory (mounted as a Docker volume at `/app/pages`). Each file
becomes a new entry in the navigation bar.

### Filename Convention

```
<sort-prefix>-<slug>.md
```

- **Sort prefix** - a number that controls the order in the nav bar (e.g. `1`,
  `5`, `10`). Files are sorted alphabetically by their full filename.
- **Slug** - lowercase, hyphen-separated words that become the URL path and nav
  label. `contact` becomes `/pages/contact` with the label "Contact";
  `privacy-policy` becomes `/pages/privacy-policy` labelled "Privacy Policy".

### Examples

| Filename              | Nav Label        | URL                    |
| --------------------- | ---------------- | ---------------------- |
| `1-about.md`          | About            | `/pages/about`         |
| `5-rules.md`          | Rules            | `/pages/rules`         |
| `9-contact.md`        | Contact          | `/pages/contact`       |
| `10-privacy-policy.md`| Privacy Policy   | `/pages/privacy-policy`|

### Impressum / Legal Notice

Operators subject to legal disclosure requirements (e.g. the German
Telemediengesetz) can create an `impressum.md` page:

```
20-impressum.md
```

Fill it with your legally required contact details - name, address, email, phone
- and it will appear in the navigation as "Impressum".
