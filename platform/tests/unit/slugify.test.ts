import { slugify } from '../../core/ingestion/IngestionService';
import { describe, expect, it } from 'bun:test';

describe('slugify', () => {
  it('keeps Ukrainian letters that the Russian-only class used to delete', () => {
    // The bug this exists for: the old character class whitelisted `а-яё`,
    // so і, ї, є and ґ were dropped from every id built from a Ukrainian name.
    expect(slugify('Київобленерго')).toBe('київобленерго');
    expect(slugify('Львівобленерго')).toBe('львівобленерго');
    expect(slugify('Ґудзик Єдність')).toBe('ґудзик_єдність');
  });

  it('does not collide two different operators onto one id', () => {
    // Both used to come out as "кивобленерго", and upsertNode then silently
    // overwrote one organisation with the other.
    expect(slugify('Київобленерго')).not.toBe(slugify('Киівобленерго'));
  });

  it('still normalises spacing, case and punctuation', () => {
    expect(slugify('  ДТЕК   Київські мережі!  ')).toBe('дтек_київські_мережі');
    expect(slugify('Acme, Inc.')).toBe('acme_inc');
  });

  it('keeps digits, underscores and hyphens', () => {
    expect(slugify('Asset_42-b')).toBe('asset_42-b');
  });

  it('leaves composed letters composed', () => {
    // NFKD used to split й into и plus a combining breve and then strip the
    // mark, quietly turning it into a different letter.
    expect(slugify('Йосип')).toBe('йосип');
    expect(slugify('Йосип')).not.toBe(slugify('Иосип'));
  });

  it('does not care which alphabet a name is written in', () => {
    expect(slugify('Ελλάδα')).toBe('ελλάδα');
    expect(slugify('日本')).toBe('日本');
  });
});
