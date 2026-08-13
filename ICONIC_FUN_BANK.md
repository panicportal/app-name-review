# Iconic / Fun Name Bank

This is an additional first-name source inside the existing Name Studio. It does
not replace or merge the normal Western bank or the artist's closed Japanese
bank.

## Data contract

Every candidate stores:

- stable candidate ID;
- exact Clothing trait;
- Body-derived gender route (`Male` or `Female`);
- name;
- category;
- reference and source URL;
- direct-connection reason;
- confidence from 1–100;
- approval status (`approved`, `proposed`, or `rejected`);
- discovery source, timestamps, and reviewer.

The permanent cloud record uses its own Redis key and revision counter. It is
therefore impossible for Iconic-bank curation to overwrite character-name
curation revisions.

## Capacity targets

Targets are calculated independently for the real Male/Female counts under each
Clothing trait:

- below 100 characters: the next multiple of five above `40 + 0.95 × count`;
- 100–199 characters: the next multiple of five above `1.5 × count`;
- 200 or more characters: the next multiple of five above `count + 100`;
- zero characters for a gender: zero required capacity, while the gender pool
  remains available for future collection changes.

These produce 60 options for 20 characters, 80 for 40, 100 for 60, 120 for 80,
150 for 100, 225 for 150, 300 for 200, and 330 for 228.

## Online discovery and validation

Online discovery is an explicit team action, never a runtime dependency for
renaming a character. The server sends several gender- and trait-specific
queries to the English Wikipedia Action API using a descriptive Wikimedia user
agent. Search results must:

1. describe a character/person/archetype related to the route;
2. contain a direct concept term in the title or evidence excerpt;
3. pass title, length, character-set, and blocked-term validation;
4. survive exact duplicate and previously-rejected checks.

Every discovered result is saved as `proposed`, even at high confidence. A team
member must inspect the evidence and approve it. Rejected records remain cached
so the same weak suggestion is not re-added.

Wikimedia evidence is a research lead, not proof by keyword alone. The UI keeps
the source link and excerpt visible so reviewers can reject false relationships.

## Character suggestion flow

Only `approved` candidates can appear in a character's replacement dialog. They
must match the exact Clothing and Body gender and must be unused across all
current and proposed first names. The saved replacement records the Iconic
candidate ID, category, reference, direct reason, and source URL in its audit
metadata.

Existing assigned names are never changed by approving, rejecting, editing,
deleting, researching, or exporting an Iconic-bank candidate.
