// ============================================================================
// CSV parsing and the import validation pass. Both are the gate an admin's
// whole estate goes through, so the cases here are the ones a real spreadsheet
// produces: quoted cells, a BOM, CRLF, a site's rows repeated, and each way a
// cell can be wrong.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { escapeCsvField, parseCsv, toCsv } from '../lib/csv';
import {
  buildExampleCsv,
  readImportRows,
  MAX_IMPORT_ROWS,
  type ImportMode,
} from './importModel';

function read(csv: string, mode: ImportMode, existingNames: string[] = []) {
  return readImportRows(parseCsv(csv), { mode, existingNames });
}

describe('parseCsv', () => {
  it('reads quoted cells holding commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x,1","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"'],
    ]);
    expect(parseCsv('a\n"one\ntwo"')).toEqual([['a'], ['one\ntwo']]);
  });

  it('absorbs a byte-order mark and blank trailing rows', () => {
    expect(parseCsv('﻿name\nAlpha\n\n')).toEqual([['name'], ['Alpha']]);
  });

  it('treats CR, LF and CRLF alike', () => {
    expect(parseCsv('a\rb\nc\r\nd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });
});

describe('escapeCsvField', () => {
  it('guards a formula but leaves a negative number alone', () => {
    expect(escapeCsvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(escapeCsvField('-2, then reset')).toBe('"\'-2, then reset"');
    // A western longitude must survive the round trip unaltered.
    expect(escapeCsvField('-2.5975')).toBe('-2.5975');
  });
});

describe('the example files', () => {
  it('import cleanly, so the guidance and the parser cannot drift apart', () => {
    const sites = read(buildExampleCsv('sites'), 'sites');
    expect(sites.errors).toEqual([]);
    expect(sites.siteCount).toBe(1);
    expect(sites.buildingCount).toBe(2);
    expect(sites.sites[0].geo).toEqual({ lat: 51.4498, lng: -2.5975 });

    const buildings = read(buildExampleCsv('buildings'), 'buildings');
    expect(buildings.errors).toEqual([]);
    expect(buildings.buildingCount).toBe(1);
  });
});

describe('readImportRows', () => {
  it('groups repeated site rows into one site with its buildings', () => {
    const csv = toCsv([
      ['site_name', 'site_address', 'building_name'],
      ['Harbour Point', '12 Harbour Road', 'Block A'],
      ['harbour point', '', 'Block B'],
      ['Quay House', '', 'Main'],
    ]);
    const result = read(csv, 'sites');
    expect(result.errors).toEqual([]);
    expect(result.siteCount).toBe(2);
    expect(result.buildingCount).toBe(3);
    expect(result.sites[0].buildings.map((row) => row.name)).toEqual([
      'Block A',
      'Block B',
    ]);
    expect(result.sites[0].address).toBe('12 Harbour Road');
  });

  it('records a site whose building column is blank, with no building', () => {
    const csv = toCsv([
      ['site_name', 'building_name'],
      ['Empty Yard', ''],
    ]);
    const result = read(csv, 'sites');
    expect(result.errors).toEqual([]);
    expect(result.siteCount).toBe(1);
    expect(result.buildingCount).toBe(0);
    expect(result.rows[0].siteOnly).toBe(true);
  });

  it('rejects a header the import does not recognise, and a missing required one', () => {
    const unknown = read(
      toCsv([
        ['site_name', 'building_name', 'sprinklers'],
        ['A', 'B', 'yes'],
      ]),
      'sites',
    );
    expect(unknown.errors).toContainEqual({
      line: 1,
      column: 'sprinklers',
      message: 'This is not a column the import recognises.',
    });

    const missing = read(toCsv([['site_name'], ['A']]), 'sites');
    expect(missing.errors.some((e) => e.column === 'building_name')).toBe(true);
  });

  it('names the row, the column and the problem for each bad cell', () => {
    const csv = toCsv([
      [
        'site_name',
        'site_latitude',
        'site_longitude',
        'building_name',
        'floors',
        'occupied_floors',
        'alarm_category',
        'fra_review_due',
        'responsible_party_role',
      ],
      ['A', '51.4', '', 'B1', '3', '5', 'Z9', '31/02/2027', 'Agent'],
    ]);
    const { errors } = read(csv, 'sites');
    const columns = errors.map((problem) => problem.column);
    expect(columns).toContain('site_longitude');
    expect(columns).toContain('occupied_floors');
    expect(columns).toContain('alarm_category');
    expect(columns).toContain('fra_review_due');
    expect(columns).toContain('responsible_party_name');
    expect(errors.every((problem) => problem.line === 2)).toBe(true);
  });

  it('reads both British and ISO dates as UTC midnight', () => {
    const csv = toCsv([
      ['site_name', 'building_name', 'fra_review_due'],
      ['A', 'B1', '01/09/2027'],
      ['A', 'B2', '2027-09-01'],
    ]);
    const result = read(csv, 'sites');
    expect(result.errors).toEqual([]);
    const due = result.sites[0].buildings.map(
      (row) => row.serviceSchedule?.fraReview?.nextDue,
    );
    expect(due[0]).toBe(Date.UTC(2027, 8, 1));
    expect(due[1]).toBe(due[0]);
  });

  it('catches a name repeated within one site, but allows it across sites', () => {
    const repeated = read(
      toCsv([
        ['site_name', 'building_name'],
        ['A', 'Block A'],
        ['A', 'block a'],
      ]),
      'sites',
    );
    expect(repeated.errors[0].column).toBe('building_name');
    expect(repeated.errors[0].line).toBe(3);

    const across = read(
      toCsv([
        ['site_name', 'building_name'],
        ['A', 'Block A'],
        ['B', 'Block A'],
      ]),
      'sites',
    );
    expect(across.errors).toEqual([]);
  });

  it('blocks a site whose repeated rows disagree about its own details', () => {
    const csv = toCsv([
      ['site_name', 'site_address', 'building_name'],
      ['A', '1 High Street', 'B1'],
      ['A', '2 Low Street', 'B2'],
    ]);
    const { errors } = read(csv, 'sites');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 3, column: 'site_address' });
  });

  it('warns without blocking when a name already exists', () => {
    const result = read(
      toCsv([
        ['building_name'],
        ['Block A'],
      ]),
      'buildings',
      ['block a'],
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.buildingCount).toBe(1);
  });

  it('refuses a file over the row cap, naming the cap', () => {
    const rows = [['site_name', 'building_name']];
    for (let index = 0; index <= MAX_IMPORT_ROWS; index += 1) {
      rows.push([`Site ${index}`, `Block ${index}`]);
    }
    const { errors } = read(toCsv(rows), 'sites');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(String(MAX_IMPORT_ROWS));
  });

  it('reports an empty file and a headings-only file honestly', () => {
    expect(read('', 'sites').errors[0].message).toBe('This file is empty.');
    expect(
      read(toCsv([['site_name', 'building_name']]), 'sites').errors[0].message,
    ).toBe('This file has column headings but no rows.');
  });
});
