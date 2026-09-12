/**
 * Turns a label into a node id.
 *
 * This file has no imports on purpose. It is the one place the rule lives, and
 * both halves of the product read it directly: the platform (CommonJS, its own
 * looser tsconfig) and the console (ESM, stricter). A file with no dependencies
 * can be pulled into either without dragging anything else across the boundary.
 *
 * The rule was duplicated before, and the copies would have drifted silently:
 * an id built one way in the console and another in the platform means
 * "pin this object to a case" points at nothing, and the platform rejects a
 * reference that does not exist without any error reaching the screen.
 *
 * The character class matters. It used to whitelist Latin plus Russian `а-яё`,
 * which silently deleted every Ukrainian letter outside that range - і, ї, є, ґ.
 * "Київобленерго" and "Киівобленерго" both came out as "кивобленерго", so two
 * different operators collided on one id and one overwrote the other. Now any
 * letter or digit in any script survives, so "which alphabets did we remember"
 * is not a question the code can get wrong.
 *
 * NFC rather than NFKD: NFKD decomposed й into и plus a combining breve and the
 * mark was then stripped, quietly turning it into a different letter.
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '_');
}
