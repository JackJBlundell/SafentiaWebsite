// ============================================================================
// PAS 79-1:2020 default assessment template (story 1015).
//
// All 12 PAS 79 subjects (01 Persons at Risk .. 12 Effects on the Environment),
// each a realistic set of starter questions. Between them the sections exercise
// EVERY question type the runner supports (text, longtext, yesno, select,
// multiselect, photo, nonConformity), include photo and nonConformity questions,
// flag several questions `allowsFlagLocation: true` (so the flag feature has
// real targets - brief 8), carry standardised fire-risk-assessment guidance on
// each question, and mark the mandatory questions `required`.
//
// Published as IMMUTABLE version 1 (status 'published'): once seeded, rules deny
// edits to a published version, and jobs PIN { templateId, version } so an
// assessment never shifts shape mid-flight (story 1031).
//
// Built from small factories rather than copy-pasted blobs so the structure
// stays maintainable and the Phase 2 template builder can extend it trivially
// (brief 10.1).
// ============================================================================

import type {
  Template,
  TemplateQuestion,
  TemplateSection,
  SectionCode,
  QuestionType,
} from '../../shared/types';
import { PAS79_TEMPLATE_VERSION } from '../ids';

// --- Question factories ------------------------------------------------------
// Each takes the section code so question ids are unique and stable across the
// whole template (e.g. `q-05-escape-routes`). Ids must never change once
// published, so they are derived deterministically from a slug.

interface QuestionOpts {
  options?: string[];
  required?: boolean;
  allowsFlagLocation?: boolean;
  allowsPhotos?: boolean;
}

function makeQuestion(
  code: SectionCode,
  slug: string,
  type: QuestionType,
  text: string,
  guidance: string,
  opts: QuestionOpts = {},
): TemplateQuestion {
  const q: TemplateQuestion = {
    id: `q-${code}-${slug}`,
    type,
    text,
    guidance,
  };
  if (opts.options) q.options = opts.options;
  if (opts.required) q.required = true;
  if (opts.allowsFlagLocation) q.allowsFlagLocation = true;
  if (opts.allowsPhotos) q.allowsPhotos = true;
  return q;
}

function section(
  code: SectionCode,
  title: string,
  questions: TemplateQuestion[],
): TemplateSection {
  return { id: `sec-${code}`, code, title, questions };
}

// --- 01 Persons at Risk ------------------------------------------------------
const SECTION_01 = section('01', 'Persons at Risk', [
  makeQuestion(
    '01',
    'occupant-profile',
    'longtext',
    'Describe the people likely to be present and their characteristics',
    'Record employees, visitors, contractors and members of the public, peak occupancy and any patterns of use. Persons at risk are central to the assessment under the Regulatory Reform (Fire Safety) Order 2005.',
    { required: true },
  ),
  makeQuestion(
    '01',
    'peak-occupancy',
    'text',
    'Estimated maximum number of persons present at any one time',
    'Give the realistic peak figure used to size means of escape. Where occupancy varies, state the worst-case scenario.',
    { required: true },
  ),
  makeQuestion(
    '01',
    'vulnerable-persons',
    'multiselect',
    'Which groups of people especially at risk are present?',
    'Identify anyone who may be unable to react to a fire warning or evacuate unaided. PEEPs (Personal Emergency Evacuation Plans) must be in place for relevant individuals.',
    {
      options: [
        'Persons with mobility impairment',
        'Persons with sensory impairment',
        'Children',
        'Elderly residents',
        'Lone workers',
        'Sleeping occupants',
        'Members of the public unfamiliar with the premises',
      ],
    },
  ),
  makeQuestion(
    '01',
    'sleeping-risk',
    'yesno',
    'Do any persons sleep on the premises?',
    'Sleeping occupants are a significant risk factor and raise the required fire-detection category. Answer yes for residential, care, hotel and similar premises.',
    { required: true },
  ),
  makeQuestion(
    '01',
    'peeps-shortfall',
    'nonConformity',
    'Are suitable PEEPs in place for all persons who need them?',
    'Where a person cannot self-evacuate and no plan exists, raise a non-conformity with severity and a clear observation. Life-safety shortfalls are normally High severity.',
    { allowsPhotos: true },
  ),
]);

// --- 02 Sources of Ignition --------------------------------------------------
const SECTION_02 = section('02', 'Sources of Ignition', [
  makeQuestion(
    '02',
    'ignition-sources',
    'multiselect',
    'Which potential sources of ignition are present?',
    'Consider all reasonably foreseeable ignition sources. Each should be controlled to reduce the likelihood of fire starting.',
    {
      options: [
        'Electrical equipment and installations',
        'Cooking appliances',
        'Heating appliances',
        'Smoking materials',
        'Hot works / maintenance',
        'Arson / deliberate ignition',
        'Naked flames',
      ],
    },
  ),
  makeQuestion(
    '02',
    'electrical-condition',
    'nonConformity',
    'Is the fixed electrical installation in satisfactory condition and within inspection date?',
    'Check for a current EICR (Electrical Installation Condition Report), no overloaded sockets, no damaged cabling and no use of unsuitable adaptors. Defects here are a common ignition source.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '02',
    'pat-testing',
    'yesno',
    'Is portable appliance testing (PAT) carried out at suitable intervals?',
    'Portable electrical equipment should be inspected and tested in line with the risk. Record the date of the last programme.',
  ),
  makeQuestion(
    '02',
    'arson-controls',
    'longtext',
    'Describe the controls in place to reduce the risk of arson',
    'Consider external waste storage away from the building, secure perimeters, lighting and removal of combustible materials from accessible areas. Arson is a leading cause of fire in commercial premises.',
  ),
  makeQuestion(
    '02',
    'ignition-evidence',
    'photo',
    'Photograph any ignition-source concern identified',
    'Capture a clear, well-lit image of the item of concern so the observation is unambiguous in the report.',
    { allowsPhotos: true },
  ),
]);

// --- 03 Sources of Fuel ------------------------------------------------------
const SECTION_03 = section('03', 'Sources of Fuel', [
  makeQuestion(
    '03',
    'combustible-materials',
    'multiselect',
    'Which significant sources of fuel are present?',
    'Identify materials that would contribute to fire growth and spread. Housekeeping and storage controls limit the available fuel load.',
    {
      options: [
        'Paper and cardboard / packaging',
        'Textiles and soft furnishings',
        'Flammable liquids',
        'Flammable gases (LPG)',
        'Plastics and foams',
        'Stored waste',
        'Display and stock materials',
      ],
    },
  ),
  makeQuestion(
    '03',
    'flammable-storage',
    'nonConformity',
    'Are flammable liquids and gases stored safely and in suitable quantities?',
    'Flammable substances should be kept to a minimum in occupied areas, stored in appropriate containers or cabinets, and segregated from ignition sources per DSEAR.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '03',
    'housekeeping',
    'select',
    'Overall standard of housekeeping',
    'Poor housekeeping increases fuel load and can obstruct escape routes. Rate against what you observe across the premises.',
    {
      options: ['Good', 'Satisfactory', 'Poor'],
      required: true,
    },
  ),
  makeQuestion(
    '03',
    'waste-management',
    'longtext',
    'Describe how combustible waste is managed and removed',
    'Record collection frequency, interim storage location and whether waste is kept clear of the building and ignition sources.',
  ),
]);

// --- 04 Construction ---------------------------------------------------------
const SECTION_04 = section('04', 'Construction, Layout and Compartmentation', [
  makeQuestion(
    '04',
    'construction-type',
    'select',
    'Predominant construction type',
    'The building fabric affects fire behaviour, compartmentation and the speed of spread. Select the closest description.',
    {
      options: [
        'Traditional masonry',
        'Steel frame',
        'Concrete frame',
        'Timber frame',
        'System / modular build',
        'Mixed construction',
      ],
      required: true,
    },
  ),
  makeQuestion(
    '04',
    'compartmentation',
    'nonConformity',
    'Is compartmentation between areas adequate and free of unsealed penetrations?',
    'Check fire-resisting walls, floors and ceilings for breaches around services, voids and ductwork. Loss of compartmentation allows fire and smoke to spread beyond the area of origin.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '04',
    'fire-doors',
    'nonConformity',
    'Are fire doors of adequate standard, correctly hung and self-closing?',
    'Inspect for correct gaps, intumescent strips and cold smoke seals, certified hinges, working self-closers and the absence of wedges. Fire doors are critical to maintaining protected routes.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '04',
    'external-cladding',
    'yesno',
    'Has the external wall construction / cladding been reviewed for fire performance?',
    'For relevant buildings, confirm whether an external wall assessment (for example an EWS1) has been carried out and reference any report.',
  ),
  makeQuestion(
    '04',
    'voids-cavities',
    'text',
    'Note any concealed voids or cavities of concern',
    'Concealed spaces can allow undetected fire spread. Record any voids lacking cavity barriers.',
  ),
]);

// --- 05 Means of Escape ------------------------------------------------------
const SECTION_05 = section('05', 'Means of Escape', [
  makeQuestion(
    '05',
    'escape-routes-adequate',
    'nonConformity',
    'Are escape routes adequate in number, width and travel distance?',
    'Assess against the occupancy and building height. Travel distances and the provision of alternative routes are fundamental to safe evacuation. Shortfalls are normally a life-safety issue.',
    { required: true, allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '05',
    'routes-unobstructed',
    'nonConformity',
    'Are all escape routes and final exits kept clear and unobstructed?',
    'Routes and exits must be free of storage, trip hazards and combustibles at all times. Obstructed escape routes are a frequent and serious finding.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '05',
    'final-exits-openable',
    'yesno',
    'Can all final exit doors be opened easily from the inside without a key?',
    'Final exits on escape routes must open in the direction of travel where required and be operable without a key, code or special knowledge while the building is occupied.',
    { required: true },
  ),
  makeQuestion(
    '05',
    'travel-distance',
    'text',
    'Maximum travel distance to a place of relative safety (metres)',
    'Record the longest travel distance observed and compare against the guidance figure for single-direction and multi-direction escape.',
  ),
  makeQuestion(
    '05',
    'evacuation-strategy',
    'select',
    'Evacuation strategy in operation',
    'The strategy must suit the building and its occupants. Confirm it is documented and understood by staff.',
    {
      options: [
        'Simultaneous evacuation',
        'Phased evacuation',
        'Progressive horizontal evacuation',
        'Stay put / defend in place',
      ],
      required: true,
    },
  ),
]);

// --- 06 Fire-fighting Equipment ----------------------------------------------
const SECTION_06 = section('06', 'Fire-fighting Equipment', [
  makeQuestion(
    '06',
    'extinguishers-provision',
    'nonConformity',
    'Are portable fire extinguishers of the correct type, quantity and location?',
    'Extinguishers should suit the risks present, be appropriately sited on escape routes, wall-mounted or on stands, and within their service date per BS 5306.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '06',
    'extinguisher-service',
    'yesno',
    'Have extinguishers been serviced within the last 12 months?',
    'Confirm the annual basic service has been carried out and the maintenance label is current.',
    { required: true },
  ),
  makeQuestion(
    '06',
    'fixed-systems',
    'multiselect',
    'Which fixed fire-fighting systems are installed?',
    'Record any fixed suppression or fire-fighting provision so its maintenance can be tracked.',
    {
      options: [
        'Sprinkler system',
        'Wet / dry rising main',
        'Hose reels',
        'Gaseous suppression',
        'Kitchen suppression (wet chemical)',
        'None',
      ],
    },
  ),
  makeQuestion(
    '06',
    'equipment-photo',
    'photo',
    'Photograph the main fire-fighting equipment provision',
    'A clear image of the equipment and its location supports the report and confirms accessibility.',
    { allowsPhotos: true },
  ),
]);

// --- 07 Fire Detection & Warning ---------------------------------------------
const SECTION_07 = section('07', 'Fire Detection and Warning', [
  makeQuestion(
    '07',
    'alarm-category',
    'select',
    'Category of the fire detection and alarm system (BS 5839)',
    'Select the installed category. The category must be appropriate to the building, its use and whether persons sleep on the premises.',
    {
      options: ['L1', 'L2', 'L3', 'L4', 'L5', 'M', 'P1', 'P2'],
      required: true,
    },
  ),
  makeQuestion(
    '07',
    'system-adequate',
    'nonConformity',
    'Is the detection and warning provision adequate for the premises and occupants?',
    'Compare the installed system against the assessed need. Inadequate detection where people sleep is a serious, often High-severity, finding.',
    { required: true, allowsPhotos: true },
  ),
  makeQuestion(
    '07',
    'audible-throughout',
    'yesno',
    'Can the alarm be heard throughout the premises?',
    'Confirm coverage including plant rooms, toilets and areas with high background noise. Visual alarm devices may be needed where occupants cannot hear.',
  ),
  makeQuestion(
    '07',
    'weekly-test',
    'yesno',
    'Is the fire alarm tested weekly and logged?',
    'A weekly test from a different call point each week, recorded in the log book, demonstrates the system is maintained and staff are familiar with the sound.',
    { required: true },
  ),
  makeQuestion(
    '07',
    'last-service-date',
    'text',
    'Date of last fire alarm service',
    'Record the date of the most recent maintenance visit (servicing is recommended at least every six months).',
  ),
]);

// --- 08 Emergency Lighting ---------------------------------------------------
const SECTION_08 = section('08', 'Emergency Escape Lighting', [
  makeQuestion(
    '08',
    'provision-adequate',
    'nonConformity',
    'Is emergency escape lighting provided where needed and adequate?',
    'Escape routes, changes of direction, stairs, final exits and fire-fighting equipment locations should be illuminated on mains failure per BS 5266.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'monthly-test',
    'yesno',
    'Are emergency lights tested monthly (function) and annually (duration)?',
    'Confirm the short monthly function test and the full-duration annual test are carried out and recorded.',
    { required: true },
  ),
  makeQuestion(
    '08',
    'coverage-photo',
    'photo',
    'Photograph a representative emergency lighting unit',
    'Capture a unit on the escape route to evidence the provision.',
    { allowsPhotos: true },
  ),
]);

// --- 09 Firefighters Provisions ----------------------------------------------
const SECTION_09 = section('09', 'Provisions for the Fire and Rescue Service', [
  makeQuestion(
    '09',
    'access-adequate',
    'yesno',
    'Is there adequate vehicle access for fire appliances?',
    'Confirm hardstanding, access routes and turning provision are adequate and kept clear for the fire and rescue service.',
  ),
  makeQuestion(
    '09',
    'water-supplies',
    'multiselect',
    'Which fire-fighting water supplies are available?',
    'Record the supplies available to the fire service so any shortfall is documented.',
    {
      options: [
        'Mains hydrants nearby',
        'Rising main (wet)',
        'Rising main (dry)',
        'Static water supply',
        'None identified',
      ],
    },
  ),
  makeQuestion(
    '09',
    'premises-information',
    'longtext',
    'Describe the premises information provided to the fire and rescue service',
    'Note any premises information box, asset plans or building information available to assist the fire service on arrival.',
  ),
  makeQuestion(
    '09',
    'firefighting-shaft',
    'yesno',
    'Are firefighting shafts / lifts provided and maintained where required?',
    'For taller buildings, confirm provision and maintenance of firefighting shafts and lifts.',
  ),
]);

// --- 10 Management -----------------------------------------------------------
const SECTION_10 = section('10', 'Management of Fire Safety', [
  makeQuestion(
    '10',
    'responsible-person',
    'text',
    'Name and role of the Responsible Person',
    'Identify the duty-holder under the Fire Safety Order who has overall responsibility for fire safety at the premises.',
    { required: true },
  ),
  makeQuestion(
    '10',
    'policy-in-place',
    'yesno',
    'Is there a written fire safety policy and emergency plan?',
    'Premises with five or more employees must have a documented fire safety arrangement. Confirm it exists and is current.',
    { required: true },
  ),
  makeQuestion(
    '10',
    'staff-training',
    'nonConformity',
    'Do staff receive suitable fire safety training and induction?',
    'Staff should know the action on discovering a fire, the warning signal, escape routes and assembly point. Lack of training is a management non-conformity.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '10',
    'drills-frequency',
    'select',
    'Frequency of fire drills',
    'Drills should normally be held at least annually, and more often for higher-risk premises. Confirm against records.',
    {
      options: [
        'At least twice a year',
        'Annually',
        'Less than annually',
        'No record of drills',
      ],
    },
  ),
  makeQuestion(
    '10',
    'logbook-maintained',
    'yesno',
    'Is a fire safety log book kept up to date?',
    'The log book should record testing, maintenance, training, drills and any incidents. It is key evidence of ongoing management.',
    { required: true },
  ),
]);

// --- 11 Signs & Signals ------------------------------------------------------
const SECTION_11 = section('11', 'Fire Safety Signs and Notices', [
  makeQuestion(
    '11',
    'escape-signage',
    'nonConformity',
    'Is escape-route signage adequate, compliant and visible?',
    'Directional and exit signs should comply with the Health and Safety (Safety Signs and Signals) Regulations and BS 5499, be clearly visible and illuminated where needed.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '11',
    'fire-action-notices',
    'yesno',
    'Are fire action notices displayed at appropriate locations?',
    'Fire action notices should be displayed at call points and exits, stating the action to take on discovering a fire and on hearing the alarm.',
    { required: true },
  ),
  makeQuestion(
    '11',
    'assembly-point',
    'text',
    'Location of the designated assembly point',
    'Record the assembly point and confirm it is at a safe distance and signed.',
  ),
  makeQuestion(
    '11',
    'signage-photo',
    'photo',
    'Photograph representative fire safety signage',
    'A photograph of the signage on a main escape route evidences the provision and its condition.',
    { allowsPhotos: true },
  ),
]);

// --- 12 Effects on the Environment -------------------------------------------
const SECTION_12 = section('12', 'Effects on the Environment', [
  makeQuestion(
    '12',
    'environmental-risk',
    'longtext',
    'Describe any environmental risks arising from a fire at the premises',
    'Consider the potential for fire water run-off, release of hazardous substances, and pollution of drains or watercourses, and any controls in place.',
  ),
  makeQuestion(
    '12',
    'hazardous-substances',
    'multiselect',
    'Which hazardous or environmentally significant substances are held?',
    'Record substances whose release in a fire could harm the environment so containment measures can be considered.',
    {
      options: [
        'Oils and fuels',
        'Chemicals',
        'Refrigerants',
        'Batteries / energy storage',
        'None significant',
      ],
    },
  ),
  makeQuestion(
    '12',
    'containment-measures',
    'yesno',
    'Are measures in place to contain fire water run-off where significant?',
    'Where a significant environmental risk exists, confirm bunding, interceptors or other containment measures are present.',
  ),
]);

// --- The published template ---------------------------------------------------
const PAS79_SECTIONS: TemplateSection[] = [
  SECTION_01,
  SECTION_02,
  SECTION_03,
  SECTION_04,
  SECTION_05,
  SECTION_06,
  SECTION_07,
  SECTION_08,
  SECTION_09,
  SECTION_10,
  SECTION_11,
  SECTION_12,
];

export const PAS79_TEMPLATE: Template = {
  name: 'PAS 79-1:2020 Fire Risk Assessment (Default)',
  version: PAS79_TEMPLATE_VERSION,
  status: 'published',
  standard: 'pas79',
  sections: PAS79_SECTIONS,
};
