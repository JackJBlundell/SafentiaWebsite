// ============================================================================
// importModel - the CSV contract for bulk site and building import, and the
// pure parse-and-validate pass behind the import dialog.
//
// Two shapes, one grammar. A SITE import carries a customer's whole estate:
// one row per building, with the site's own columns repeated on each of its
// rows, because that is what a spreadsheet a facilities manager already keeps
// looks like. Rows are then grouped by site name. A BUILDING import is the
// same file with the site columns dropped, landing on one already-chosen site.
//
// Everything here is pure and synchronous: the whole file is validated before
// a single record is sent, so the dialog can show every problem at once and an
// import is all-or-nothing. The importRecords callable re-validates every
// field regardless - this pass exists to give a plain-language answer without
// a round trip, never as the security boundary.
// ============================================================================

import { toCsv } from '../lib/csv';
import { isValidEmail } from './shared';
import { ALARM_CATEGORIES, SERVICE_SCHEDULE_KEYS } from '../../types';
import type {
  AlarmCategory,
  BuildingDetails,
  ImportBuildingRow,
  ImportSiteRow,
  ResponsibleParty,
} from '../../types';

/** The most rows one file may carry. Well past any real estate, and low enough
 *  that the whole import stays inside a single atomic write. */
export const MAX_IMPORT_ROWS = 500;

/** Mirrors manageBuilding's DETAIL_LIMITS so the dialog rejects an absurd
 *  figure in plain English rather than surfacing a server rejection. */
const DETAIL_LIMITS = {
  area: 10_000_000,
  floors: 200,
  occupiedFloors: 200,
  occupants: 100_000,
} as const;

/** Mirrors TEXT_LIMITS in functions/src/lib/validate. */
const TEXT_LIMITS = { shortText: 200, displayName: 120, email: 254 } as const;

export type ImportMode = 'sites' | 'buildings';

export interface ImportColumn {
  header: string;
  required: boolean;
  /** Plain-language guidance shown in the dialog's data-model table. */
  help: string;
  /** The value written into the downloadable example file. */
  example: string;
}

const SITE_COLUMNS: readonly ImportColumn[] = [
  {
    header: 'site_name',
    required: true,
    help: 'The site name. Repeat it on every row that belongs to that site.',
    example: 'Harbour Point',
  },
  {
    header: 'site_address',
    required: false,
    help: 'One line, as you would write it on a letter.',
    example: '12 Harbour Road, Bristol, BS1 5UH',
  },
  {
    header: 'site_email',
    required: false,
    help: 'A general contact address for the site.',
    example: 'facilities@example.co.uk',
  },
  {
    header: 'site_phone',
    required: false,
    help: 'A general contact number for the site.',
    example: '0117 496 0000',
  },
  {
    header: 'site_latitude',
    required: false,
    help: 'Decimal degrees between -90 and 90. Leave both coordinates blank if you do not have them.',
    example: '51.4498',
  },
  {
    header: 'site_longitude',
    required: false,
    help: 'Decimal degrees between -180 and 180. Required if a latitude is given.',
    example: '-2.5975',
  },
];

const BUILDING_COLUMNS: readonly ImportColumn[] = [
  {
    header: 'building_name',
    required: true,
    help: 'The building name, unique within its site.',
    example: 'Block A',
  },
  {
    header: 'building_address',
    required: false,
    help: 'Only if it differs from the site address.',
    example: '12 Harbour Road, Bristol, BS1 5UH',
  },
  {
    header: 'responsible_person',
    required: false,
    help: 'The named person on site, if you record one.',
    example: 'Alice Fenwick',
  },
  {
    header: 'responsible_party_name',
    required: false,
    help: 'The party accountable for fire safety. Required if any other responsible_party column is filled in.',
    example: 'Harbour Estates Ltd',
  },
  {
    header: 'responsible_party_role',
    required: false,
    help: 'Their role or job title.',
    example: 'Managing agent',
  },
  {
    header: 'responsible_party_email',
    required: false,
    help: 'Their email address.',
    example: 'safety@harbourestates.co.uk',
  },
  {
    header: 'responsible_party_phone',
    required: false,
    help: 'Their phone number.',
    example: '0117 496 0001',
  },
  {
    header: 'article_53_persons',
    required: false,
    help: 'Article 5(3) duty-holders. Separate several names with semicolons.',
    example: 'Alice Fenwick; Mark Doyle',
  },
  {
    header: 'floor_area_m2',
    required: false,
    help: `Floor area in square metres, up to ${DETAIL_LIMITS.area.toLocaleString('en-GB')}.`,
    example: '2400',
  },
  {
    header: 'floors',
    required: false,
    help: `Total number of floors, up to ${DETAIL_LIMITS.floors}.`,
    example: '6',
  },
  {
    header: 'occupied_floors',
    required: false,
    help: `Floors in use, up to ${DETAIL_LIMITS.occupiedFloors}.`,
    example: '5',
  },
  {
    header: 'occupants',
    required: false,
    help: `Typical number of occupants, up to ${DETAIL_LIMITS.occupants.toLocaleString('en-GB')}.`,
    example: '180',
  },
  {
    header: 'is_landlord',
    required: false,
    help: 'Whether your customer is the landlord. Yes or no.',
    example: 'yes',
  },
  {
    header: 'alarm_type',
    required: false,
    help: 'The alarm system as you describe it.',
    example: 'Addressable panel',
  },
  {
    header: 'alarm_category',
    required: false,
    help: `One of ${ALARM_CATEGORIES.join(', ')}.`,
    example: 'L2',
  },
  {
    header: 'fra_review_due',
    required: false,
    help: 'Date the next fire risk assessment review is due, as DD/MM/YYYY or YYYY-MM-DD.',
    example: '01/09/2027',
  },
];

/** The columns a file must use, for the given mode, in the order the example
 *  file writes them. */
export function columnsFor(mode: ImportMode): readonly ImportColumn[] {
  return mode === 'sites'
    ? [...SITE_COLUMNS, ...BUILDING_COLUMNS]
    : BUILDING_COLUMNS;
}

/** What the CSV deliberately does not carry, stated in the dialog so nobody
 *  hunts for a column that is not there. */
export const IMPORT_EXCLUSIONS: readonly string[] = [
  'Site contacts. Import the sites, then link a contact on the site record.',
  'Building photos and floor plans. Upload those on the building record.',
  `Service dates other than the FRA review (${SERVICE_SCHEDULE_KEYS.length - 1} others). Set them on the building's service schedule.`,
  'Risk ratings and last-assessed dates. The platform derives those from released assessments and never accepts them from a file.',
];

// ----------------------------------------------------------------------------
// Problems - one per row, per column, in plain language.
// ----------------------------------------------------------------------------

export interface ImportProblem {
  /** The line number in the file as a spreadsheet shows it, header being 1. */
  line: number;
  column: string;
  message: string;
}

export interface ImportPreviewRow {
  line: number;
  siteName: string;
  buildingName: string;
  /** True when this row contributes no building (a site recorded with none). */
  siteOnly: boolean;
  valid: boolean;
}

export interface ImportParseResult {
  /** Present only when there are no errors, ready to send as the callable input. */
  sites: ImportSiteRow[];
  /** Flat building list for a buildings-mode import. */
  buildings: ImportBuildingRow[];
  rows: ImportPreviewRow[];
  errors: ImportProblem[];
  /** Non-blocking notes, chiefly names that already exist. */
  warnings: ImportProblem[];
  siteCount: number;
  buildingCount: number;
}

// ----------------------------------------------------------------------------
// Cell readers. Each returns undefined for an absent value and pushes a
// problem rather than throwing, so one bad cell never hides the rest.
// ----------------------------------------------------------------------------

/** Undo the spreadsheet formula-injection guard applied on export
 *  (`escapeCsvField` prefixes an apostrophe to a cell opening with = + - @).
 *  Without this, exporting and re-importing accumulates a quote per round trip
 *  and turns `+441179...` into `'+441179...`.
 *
 *  Deliberately narrow: the apostrophe is only removed when the character after
 *  it is one the guard actually escapes. A leading apostrophe is legitimate in
 *  real place names, so blanket stripping would corrupt an address in
 *  's-Hertogenbosch. */
function unguardCell(value: string): string {
  if (value.length < 2 || value[0] !== "'") return value;
  return /[=+\-@]/.test(value[1] ?? '') ? value.slice(1) : value;
}

interface CellContext {
  line: number;
  errors: ImportProblem[];
  get: (header: string) => string;
}

function text(
  ctx: CellContext,
  header: string,
  max: number,
): string | undefined {
  const value = ctx.get(header);
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > max) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `This is too long. Keep it to ${max} characters or fewer.`,
    });
    return undefined;
  }
  return value;
}

function email(ctx: CellContext, header: string): string | undefined {
  const value = text(ctx, header, TEXT_LIMITS.email);
  if (value === undefined) {
    return undefined;
  }
  if (!isValidEmail(value)) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: 'This does not look like an email address.',
    });
    return undefined;
  }
  return value;
}

/** A count or measurement: digits, optionally with a decimal part. Thousands
 *  separators are stripped because spreadsheets export them freely. */
function number(
  ctx: CellContext,
  header: string,
  max: number,
): number | undefined {
  const raw = ctx.get(header);
  if (raw.length === 0) {
    return undefined;
  }
  const cleaned = raw.replace(/[\s,]/g, '');
  const parsed = Number(cleaned);
  if (!/^\d+(\.\d+)?$/.test(cleaned) || !Number.isFinite(parsed)) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `"${raw}" is not a number.`,
    });
    return undefined;
  }
  if (parsed > max) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `This cannot be more than ${max.toLocaleString('en-GB')}.`,
    });
    return undefined;
  }
  return parsed;
}

const TRUE_WORDS = ['yes', 'y', 'true', '1'];
const FALSE_WORDS = ['no', 'n', 'false', '0'];

function boolean(ctx: CellContext, header: string): boolean | undefined {
  const raw = ctx.get(header);
  if (raw.length === 0) {
    return undefined;
  }
  const word = raw.toLowerCase();
  if (TRUE_WORDS.includes(word)) {
    return true;
  }
  if (FALSE_WORDS.includes(word)) {
    return false;
  }
  ctx.errors.push({
    line: ctx.line,
    column: header,
    message: `"${raw}" is not yes or no.`,
  });
  return undefined;
}

/** A coordinate in decimal degrees, within a hemisphere's bounds. Negatives are
 *  legal here, so this cannot share the positive-number reader. */
function coordinate(
  ctx: CellContext,
  header: string,
  bound: number,
): number | undefined {
  const raw = ctx.get(header);
  if (raw.length === 0) {
    return undefined;
  }
  const cleaned = raw.replace(/[\s,]/g, '');
  const parsed = Number(cleaned);
  if (!/^-?\d+(\.\d+)?$/.test(cleaned) || !Number.isFinite(parsed)) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `"${raw}" is not a decimal coordinate, for example 51.4498.`,
    });
    return undefined;
  }
  if (parsed < -bound || parsed > bound) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `This must be between -${bound} and ${bound}.`,
    });
    return undefined;
  }
  return parsed;
}

/** A British date (DD/MM/YYYY) or an ISO one (YYYY-MM-DD), read as UTC midnight
 *  so a stored due-date never shifts across a timezone boundary. The round-trip
 *  check rejects impossible dates such as 31/02/2027, which Date would
 *  otherwise roll forward into March without complaint. */
function dueDate(ctx: CellContext, header: string): number | undefined {
  const raw = ctx.get(header);
  if (raw.length === 0) {
    return undefined;
  }
  const british = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  let year = 0;
  let month = 0;
  let day = 0;
  if (british) {
    day = Number(british[1]);
    month = Number(british[2]);
    year = Number(british[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `"${raw}" is not a date. Use DD/MM/YYYY, for example 01/09/2027.`,
    });
    return undefined;
  }
  const millis = Date.UTC(year, month - 1, day);
  const check = new Date(millis);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    ctx.errors.push({
      line: ctx.line,
      column: header,
      message: `"${raw}" is not a real date.`,
    });
    return undefined;
  }
  return millis;
}

// ----------------------------------------------------------------------------
// Row readers.
// ----------------------------------------------------------------------------

/** Read one row's building columns. Returns undefined when the row names no
 *  building, which in a site import means "this site has none yet". */
function readBuilding(ctx: CellContext): ImportBuildingRow | undefined {
  const name = text(ctx, 'building_name', TEXT_LIMITS.shortText);
  if (name === undefined) {
    return undefined;
  }

  const details: BuildingDetails = {};
  const area = number(ctx, 'floor_area_m2', DETAIL_LIMITS.area);
  const floors = number(ctx, 'floors', DETAIL_LIMITS.floors);
  const occupiedFloors = number(
    ctx,
    'occupied_floors',
    DETAIL_LIMITS.occupiedFloors,
  );
  const occupants = number(ctx, 'occupants', DETAIL_LIMITS.occupants);
  const isLandlord = boolean(ctx, 'is_landlord');
  const alarmType = text(ctx, 'alarm_type', TEXT_LIMITS.shortText);
  const alarmRaw = ctx.get('alarm_category');
  if (area !== undefined) details.area = area;
  if (floors !== undefined) details.floors = floors;
  if (occupiedFloors !== undefined) details.occupiedFloors = occupiedFloors;
  if (occupants !== undefined) details.occupants = occupants;
  if (isLandlord !== undefined) details.isLandlord = isLandlord;
  if (alarmType !== undefined) details.alarmType = alarmType;
  if (alarmRaw.length > 0) {
    const matched = ALARM_CATEGORIES.find(
      (category) => category.toLowerCase() === alarmRaw.toLowerCase(),
    );
    if (matched === undefined) {
      ctx.errors.push({
        line: ctx.line,
        column: 'alarm_category',
        message: `"${alarmRaw}" is not a category. Use one of ${ALARM_CATEGORIES.join(', ')}.`,
      });
    } else {
      details.alarmCategory = matched as AlarmCategory;
    }
  }
  if (floors !== undefined && occupiedFloors !== undefined && occupiedFloors > floors) {
    ctx.errors.push({
      line: ctx.line,
      column: 'occupied_floors',
      message: 'A building cannot have more occupied floors than floors.',
    });
  }

  // A party is only meaningful with a name, so a role or email on its own is a
  // half-filled row the admin meant to complete.
  const partyName = text(ctx, 'responsible_party_name', TEXT_LIMITS.displayName);
  const partyRole = text(ctx, 'responsible_party_role', TEXT_LIMITS.shortText);
  const partyEmail = email(ctx, 'responsible_party_email');
  const partyPhone = text(ctx, 'responsible_party_phone', TEXT_LIMITS.shortText);
  let responsibleParty: ResponsibleParty | undefined;
  if (partyName !== undefined) {
    responsibleParty = { name: partyName };
    if (partyRole !== undefined) responsibleParty.role = partyRole;
    if (partyEmail !== undefined) responsibleParty.email = partyEmail;
    if (partyPhone !== undefined) responsibleParty.phone = partyPhone;
  } else if (
    ctx.get('responsible_party_role').length > 0 ||
    ctx.get('responsible_party_email').length > 0 ||
    ctx.get('responsible_party_phone').length > 0
  ) {
    ctx.errors.push({
      line: ctx.line,
      column: 'responsible_party_name',
      message:
        'Give the responsible party a name, or clear the other responsible_party columns.',
    });
  }

  const article53 = ctx
    .get('article_53_persons')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (article53.some((entry) => entry.length > TEXT_LIMITS.displayName)) {
    ctx.errors.push({
      line: ctx.line,
      column: 'article_53_persons',
      message: `Each name must be ${TEXT_LIMITS.displayName} characters or fewer.`,
    });
  }

  const fraReview = dueDate(ctx, 'fra_review_due');

  const row: ImportBuildingRow = { name };
  const address = text(ctx, 'building_address', TEXT_LIMITS.shortText);
  const responsiblePerson = text(
    ctx,
    'responsible_person',
    TEXT_LIMITS.displayName,
  );
  if (address !== undefined) row.address = address;
  if (responsiblePerson !== undefined) row.responsiblePerson = responsiblePerson;
  if (responsibleParty !== undefined) row.responsibleParty = responsibleParty;
  if (article53.length > 0) row.article53Persons = article53;
  if (Object.keys(details).length > 0) row.details = details;
  if (fraReview !== undefined) {
    row.serviceSchedule = { fraReview: { nextDue: fraReview } };
  }
  return row;
}

/** Read one row's site columns. Errors when the site has no name; the caller
 *  drops the row from the import in that case. */
function readSite(ctx: CellContext): ImportSiteRow | undefined {
  const name = text(ctx, 'site_name', TEXT_LIMITS.shortText);
  if (name === undefined) {
    ctx.errors.push({
      line: ctx.line,
      column: 'site_name',
      message: 'Every row needs a site name.',
    });
    return undefined;
  }
  const site: ImportSiteRow = { name, buildings: [] };
  const address = text(ctx, 'site_address', TEXT_LIMITS.shortText);
  const siteEmail = email(ctx, 'site_email');
  const phone = text(ctx, 'site_phone', TEXT_LIMITS.shortText);
  const lat = coordinate(ctx, 'site_latitude', 90);
  const lng = coordinate(ctx, 'site_longitude', 180);
  if (address !== undefined) site.address = address;
  if (siteEmail !== undefined) site.email = siteEmail;
  if (phone !== undefined) site.phone = phone;
  if (lat !== undefined && lng !== undefined) {
    site.geo = { lat, lng };
  } else if (lat !== undefined || lng !== undefined) {
    // A half-coordinate cannot be placed on a map, and silently dropping it
    // would lose data the admin believed they had provided.
    ctx.errors.push({
      line: ctx.line,
      column: lat === undefined ? 'site_latitude' : 'site_longitude',
      message: 'Give both a latitude and a longitude, or neither.',
    });
  }
  return site;
}

// ----------------------------------------------------------------------------
// The whole-file pass.
// ----------------------------------------------------------------------------

export interface ImportContext {
  mode: ImportMode;
  /** Existing site names under the customer (sites mode) or building names on
   *  the site (buildings mode), for the already-exists warning. */
  existingNames: readonly string[];
}

/** A name comparison that matches how a person reads it: case and surrounding
 *  space are not a distinction anyone intends. */
function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Validate a parsed CSV grid against the mode's column contract. Returns every
 * problem found, plus the payload the callable takes when there are none.
 */
export function readImportRows(
  grid: readonly string[][],
  context: ImportContext,
): ImportParseResult {
  const columns = columnsFor(context.mode);
  const errors: ImportProblem[] = [];
  const warnings: ImportProblem[] = [];
  const empty: ImportParseResult = {
    sites: [],
    buildings: [],
    rows: [],
    errors,
    warnings,
    siteCount: 0,
    buildingCount: 0,
  };

  if (grid.length === 0) {
    errors.push({ line: 1, column: 'file', message: 'This file is empty.' });
    return empty;
  }

  // Headers are matched case-insensitively and space-tolerantly, since a
  // spreadsheet round trip often retitles them; anything unrecognised is
  // reported rather than ignored, so a typo is never silently dropped data.
  const headerRow = grid[0].map((cell) => nameKey(cell).replace(/\s/g, '_'));
  const known = new Map(columns.map((column) => [column.header, column]));
  const positions = new Map<string, number>();
  headerRow.forEach((header, index) => {
    if (header.length === 0) {
      return;
    }
    if (!known.has(header)) {
      errors.push({
        line: 1,
        column: header,
        message: 'This is not a column the import recognises.',
      });
      return;
    }
    if (positions.has(header)) {
      errors.push({
        line: 1,
        column: header,
        message: 'This column appears more than once.',
      });
      return;
    }
    positions.set(header, index);
  });
  for (const column of columns) {
    if (column.required && !positions.has(column.header)) {
      errors.push({
        line: 1,
        column: column.header,
        message: 'This column is required and is missing from the file.',
      });
    }
  }
  if (errors.length > 0) {
    return empty;
  }

  const dataRows = grid.slice(1);
  if (dataRows.length === 0) {
    errors.push({
      line: 1,
      column: 'file',
      message: 'This file has column headings but no rows.',
    });
    return empty;
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    errors.push({
      line: 1,
      column: 'file',
      message: `This file has ${dataRows.length} rows. Import at most ${MAX_IMPORT_ROWS} at a time, then repeat with the rest.`,
    });
    return empty;
  }

  const preview: ImportPreviewRow[] = [];
  // Sites in first-seen order, so the preview reads in the file's own order.
  const siteOrder: string[] = [];
  const sitesByKey = new Map<string, ImportSiteRow>();
  const siteFirstLine = new Map<string, number>();
  const buildingKeysBySite = new Map<string, Map<string, number>>();
  const flatBuildings: ImportBuildingRow[] = [];
  const existing = new Set(context.existingNames.map(nameKey));

  dataRows.forEach((cells, index) => {
    const line = index + 2;
    const before = errors.length;

    // A row holding MORE values than the file has columns is data this pass
    // would otherwise drop in silence, and the usual cause is a comma or a
    // quote mark inside a cell that was never quoted, which also shifts every
    // later value into the wrong column. Importing that would write plausible
    // but wrong records, so it is an error, not a tolerance. Trailing empty
    // values are ignored: spreadsheets pad rows with commas routinely.
    const overflow = cells
      .slice(headerRow.length)
      .filter((value) => value.trim().length > 0);
    if (overflow.length > 0) {
      errors.push({
        line,
        column: 'file',
        message:
          'This row has more values than the file has columns. Check for a comma or a quote mark inside a cell, and put quotes around it.',
      });
    }

    const ctx: CellContext = {
      line,
      errors,
      get: (header) => {
        const position = positions.get(header);
        if (position === undefined) return '';
        return unguardCell((cells[position] ?? '').trim());
      },
    };

    const building = readBuilding(ctx);

    if (context.mode === 'buildings') {
      if (building === undefined) {
        errors.push({
          line,
          column: 'building_name',
          message: 'Every row needs a building name.',
        });
      } else {
        const key = nameKey(building.name);
        const seen = buildingKeysBySite.get('') ?? new Map<string, number>();
        const firstLine = seen.get(key);
        if (firstLine !== undefined) {
          errors.push({
            line,
            column: 'building_name',
            message: `"${building.name}" is already on line ${firstLine} of this file.`,
          });
        } else {
          seen.set(key, line);
          buildingKeysBySite.set('', seen);
          flatBuildings.push(building);
        }
        if (existing.has(key)) {
          warnings.push({
            line,
            column: 'building_name',
            message: `A building called "${building.name}" is already on this site. Importing adds a second one.`,
          });
        }
      }
      preview.push({
        line,
        siteName: '',
        buildingName: building?.name ?? '',
        siteOnly: false,
        valid: errors.length === before,
      });
      return;
    }

    const site = readSite(ctx);
    if (site === undefined) {
      preview.push({
        line,
        siteName: '',
        buildingName: building?.name ?? '',
        siteOnly: building === undefined,
        valid: false,
      });
      return;
    }

    const key = nameKey(site.name);
    let record = sitesByKey.get(key);
    if (record === undefined) {
      record = site;
      sitesByKey.set(key, site);
      siteOrder.push(key);
      siteFirstLine.set(key, line);
      buildingKeysBySite.set(key, new Map());
      if (existing.has(key)) {
        warnings.push({
          line,
          column: 'site_name',
          message: `A site called "${site.name}" already exists for this customer. Importing creates a second one.`,
        });
      }
    } else {
      // The site's own columns are repeated on each of its rows, so a
      // disagreement means two different sites share a name or a cell was
      // mistyped. Either way it cannot be resolved by guessing.
      const first = siteFirstLine.get(key) ?? line;
      const conflicts: Array<[string, string | undefined, string | undefined]> = [
        ['site_address', record.address, site.address],
        ['site_email', record.email, site.email],
        ['site_phone', record.phone, site.phone],
        [
          'site_latitude',
          record.geo && String(record.geo.lat),
          site.geo && String(site.geo.lat),
        ],
        [
          'site_longitude',
          record.geo && String(record.geo.lng),
          site.geo && String(site.geo.lng),
        ],
      ];
      for (const [column, held, given] of conflicts) {
        if (given !== undefined && held !== undefined && given !== held) {
          errors.push({
            line,
            column,
            message: `This does not match what line ${first} gives for "${record.name}". Every row for one site must repeat the same site details.`,
          });
        }
      }
      // A detail given on a later row and left blank on the first is filled in
      // rather than lost, which is how a part-completed spreadsheet reads.
      if (record.address === undefined && site.address !== undefined) {
        record.address = site.address;
      }
      if (record.email === undefined && site.email !== undefined) {
        record.email = site.email;
      }
      if (record.phone === undefined && site.phone !== undefined) {
        record.phone = site.phone;
      }
      if (record.geo === undefined && site.geo !== undefined) {
        record.geo = site.geo;
      }
    }

    if (building !== undefined) {
      const seen = buildingKeysBySite.get(key) ?? new Map<string, number>();
      const buildingKey = nameKey(building.name);
      const firstLine = seen.get(buildingKey);
      if (firstLine !== undefined) {
        errors.push({
          line,
          column: 'building_name',
          message: `"${building.name}" is already listed for "${record.name}" on line ${firstLine}.`,
        });
      } else {
        seen.set(buildingKey, line);
        buildingKeysBySite.set(key, seen);
        record.buildings.push(building);
      }
    }

    preview.push({
      line,
      siteName: record.name,
      buildingName: building?.name ?? '',
      siteOnly: building === undefined,
      valid: errors.length === before,
    });
  });

  const sites = siteOrder
    .map((key) => sitesByKey.get(key))
    .filter((site): site is ImportSiteRow => site !== undefined);

  return {
    sites: context.mode === 'sites' ? sites : [],
    buildings: context.mode === 'buildings' ? flatBuildings : [],
    rows: preview,
    errors,
    warnings,
    siteCount: context.mode === 'sites' ? sites.length : 0,
    buildingCount:
      context.mode === 'sites'
        ? sites.reduce((total, site) => total + site.buildings.length, 0)
        : flatBuildings.length,
  };
}

/** The downloadable example: the header row, one filled example row, and a
 *  second row showing a site's other building (sites mode) so the repeat-the-
 *  site-columns rule is visible rather than only described. */
export function buildExampleCsv(mode: ImportMode): string {
  const columns = columnsFor(mode);
  const header = columns.map((column) => column.header);
  const first = columns.map((column) => column.example);
  const second = columns.map((column) => {
    if (column.header.startsWith('site_')) {
      return column.example;
    }
    if (column.header === 'building_name') {
      return 'Block B';
    }
    if (column.header === 'floors') {
      return '4';
    }
    if (column.header === 'occupied_floors') {
      return '4';
    }
    if (column.header === 'floor_area_m2') {
      return '1600';
    }
    if (column.header === 'occupants') {
      return '95';
    }
    return column.example;
  });
  return toCsv(mode === 'sites' ? [header, first, second] : [header, first]);
}
