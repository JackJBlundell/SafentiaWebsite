// ============================================================================
// renderSampleReport - developer script: render a representative report PDF
// with NO emulator, network or credentials.
//
// The renderer (report/render.ts) is pure presentation: it takes a fully
// resolved ReportModel and returns PDF bytes. So this script builds a rich
// model BY HAND - shaped like the seed's demo world - and renders it, giving
// the team a real PDF to eyeball for layout regressions:
//   - 12 Section 2 subjects, including one observation LONGER THAN A PAGE
//     (exercising the row split + repeated Question/Answer header),
//   - photo/flag-composite placeholders (unavailable images render the honest
//     "image unavailable" box - no bytes needed),
//   - a full severity-ordered action plan with a flag composite slot,
//   - org branding (name, brand colour; logo intentionally unavailable),
//   - 'Page N of M' footers via the buffered final pass.
//
// Run (from functions/):  npm run render:sample  [-- /path/to/out.pdf]
// Default output: ./sample-report.pdf (the functions/ directory).
// ============================================================================

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderReportPdf } from '../report/render';
import type {
  ReportAction,
  ReportModel,
  ReportSection,
  ResolvedImage,
} from '../report/assemble';

/** An intentionally-unavailable image: the renderer paints its titled
 *  "image unavailable" placeholder box, so no bytes are required. */
function placeholder(title: string): ResolvedImage {
  return { title, available: false };
}

/** Deterministic filler prose (no lorem-ipsum dependency). */
function prose(sentences: number): string {
  const bank = [
    'The escape route was found to be partially obstructed by stored materials at the time of inspection.',
    'Compartmentation between the riser cupboard and the adjoining corridor requires attention.',
    'The self-closing device did not bring the door fully to the rebate from the standing-open position.',
    'Signage along the corridor was legible and correctly directional throughout.',
    'Emergency lighting operated on test at each of the sampled call points.',
    'The responsible person should ensure records of weekly alarm tests are maintained in the log book.',
    'Combustible storage should be relocated away from the electrical intake cupboard as a priority.',
    'The dry riser inlet cabinet was secure and its signage compliant with the relevant standard.',
  ];
  const out: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    out.push(bank[i % bank.length]);
  }
  return out.join(' ');
}

/** 12 subjects, one carrying an observation well over a page of text. */
function buildSections(): ReportSection[] {
  const titles = [
    'Means of Escape',
    'Fire Doors',
    'Compartmentation',
    'Fire Detection and Alarm',
    'Emergency Lighting',
    'Signage and Notices',
    'Firefighting Equipment',
    'Electrical Hazards',
    'Housekeeping and Storage',
    'Arson Prevention',
    'External Wall Systems',
    'Management of Fire Safety',
  ];
  return titles.map((title, index) => {
    const code = `S${index + 1}`;
    const rows: ReportSection['rows'] = [
      {
        questionText: `Are the ${title.toLowerCase()} arrangements adequate for the building's use and occupancy profile?`,
        answerText: index % 3 === 0 ? 'No' : 'Yes',
        questionType: 'yesno',
        guidance:
          'Consider the building height, occupancy and the evacuation strategy in force.',
        ...(index % 3 === 0
          ? {
              observation:
                index === 3
                  ? // The page-splitting stress case: an observation far longer
                    // than one A4 page of small text (~120 sentences).
                    prose(120)
                  : prose(6),
              severity: (['H', 'M', 'L'] as const)[index % 3],
            }
          : {}),
        ...(index === 1
          ? {
              photos: [
                placeholder('Door to riser cupboard, third floor'),
                placeholder('Self-closer detail'),
                placeholder('Intumescent strip condition'),
              ],
            }
          : {}),
      },
      {
        questionText: `Is documentation relating to ${title.toLowerCase()} available and current?`,
        answerText: 'Documentation reviewed on site; certificates current.',
        questionType: 'text',
      },
      {
        questionText: 'Overall condition assessment for this subject',
        answerText: index % 4 === 0 ? 'Requires improvement' : 'Satisfactory',
        questionType: 'select',
        options: ['Satisfactory', 'Requires improvement', 'Unsatisfactory'],
        ...(index % 4 === 0
          ? { observation: prose(4), severity: 'M' as const }
          : {}),
      },
    ];
    return { code, title, rows };
  });
}

function buildActions(): ReportAction[] {
  const severities = ['H', 'H', 'M', 'M', 'M', 'L', 'L'] as const;
  return severities.map((severity, index) => ({
    severity,
    sectionCode: `S${(index % 12) + 1}`,
    question: `Are the arrangements adequate for the building's use? (finding ${index + 1})`,
    observation: prose(3 + (index % 4)),
    responsible: index % 2 === 0 ? 'Aisha Patel (Facilities)' : 'Managing agent',
    dueBy: Date.UTC(2026, 8 + (index % 3), 14),
    lifeProtection: index < 2,
    // The flag-location composite slot (legacy "Location" parity, 1057 AC2).
    flagImage: placeholder(`Location flag - floor ${1 + (index % 4)}`),
    images:
      index % 2 === 0
        ? [placeholder('Defect photograph'), placeholder('Wider context view')]
        : [],
  }));
}

function buildModel(): ReportModel {
  return {
    orgProfile: {
      name: 'Harrison Fire Consultancy Ltd',
      brand: { primary: '#0E7490', secondary: '#155E75' },
      contact: {
        name: 'James Harrison',
        email: 'assessments@harrisonfire.example.co.uk',
        phone: '0161 496 0000',
      },
    },
    standard: 'pas79',
    logo: placeholder('Organisation logo'),
    overview: {
      address: 'Marlowe House, 14 Weaver Street, Manchester, M3 5GT',
      responsiblePerson: 'Northgate Residential Management Ltd',
      article53Persons: ['Building manager (day)', 'Concierge (24h)'],
      orgContactName: 'James Harrison',
      orgContactEmail: 'assessments@harrisonfire.example.co.uk',
      orgContactPhone: '0161 496 0000',
      buildingId: 'bldg-marlowe-house',
      assessmentId: 'job-2026-0457',
      dateCarriedOut: Date.UTC(2026, 6, 2),
      riskLevel: 'medium',
      buildingDetailLines: [
        'Six storeys; purpose-built residential above ground-floor retail',
        '48 flats; single protected stair; stay-put evacuation strategy',
        'Construction circa 1998; brick and block with concrete floors',
      ],
      assessmentDetailLines: [
        'Type 1 (common parts, non-destructive) fire risk assessment',
        'All communal areas accessed; 10% sample of flat entrance doors',
        'Weather at time of visit: dry; access unrestricted',
      ],
    },
    buildingPhoto: placeholder('General view of the premises'),
    riskDistribution: { low: 9, medium: 5, high: 2 },
    narrative: {
      summary:
        'The premises presented a generally sound standard of fire safety, with well-maintained escape routes and current statutory testing. A small number of non-conformities were identified, principally around fire door condition and storage in the ground-floor riser cupboard, and these are set out in the action plan with proportionate timescales.',
      buildingDescription:
        'A six-storey purpose-built block of 48 flats above ground-floor retail units, served by a single protected staircase with AOV provision at each level.',
      premisesCovered:
        'The common parts only: entrance lobbies, corridors, staircase, plant and riser cupboards, refuse store and external areas within the curtilage.',
      incidentHistory:
        'No recorded fire incidents in the previous five years. Two false alarms attributed to cooking fumes were logged in the last twelve months.',
      riskOpinion:
        'Taking into account the fire protection measures observed and the management arrangements in place, the risk to occupants is considered MEDIUM. Completion of the action plan would support a lower risk at review.',
    },
    sections: buildSections(),
    actions: buildActions(),
    signOff: {
      conductedBy: 'James Harrison GIFireE',
      checkedBy: 'Priya Nair MIFireE',
      validatedBy: 'Priya Nair MIFireE',
      releasedOn: Date.UTC(2026, 6, 9),
      reviewByDate: Date.UTC(2027, 6, 9),
    },
    generatedAt: Date.UTC(2026, 6, 9, 10, 30),
  };
}

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? './sample-report.pdf');
  const pdf = await renderReportPdf(buildModel());
  writeFileSync(outPath, pdf);
  console.log(`Sample report written: ${outPath} (${pdf.length} bytes)`);
  console.log(
    'Open it and check: Section 2 long-observation row splits across pages ' +
      'with the Question/Answer header repeated, and every footer reads "Page N of M".',
  );
}

void main().catch((error) => {
  console.error('renderSampleReport failed:', error);
  process.exit(1);
});
