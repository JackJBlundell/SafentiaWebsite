// ============================================================================
// BS 9792 Housing Fire Risk Assessment base template.
//
// A faithful transcription of the BS 9792 (Regulatory Reform (Fire Safety)
// Order 2005 - Housing) fire risk assessment form: houses in multiple
// occupation, blocks of flats/maisonettes and specialised housing. Every
// numbered section of the source form (1 The Premises .. 32 Engagement with
// Residents) is represented as a TemplateSection, preceded by a General
// Information metadata section and closed by a Fire Risk Evaluation summary.
//
// The hazard "Obs/Rec" observation items (the "Select" rows under each hazard,
// e.g. 7.2 a)-h)) are modelled as `nonConformity` questions so an assessor can
// raise a finding + action against each, with the standardised BS 9792
// observation/recommendation guidance carried inline on the `guidance` field.
//
// Published as IMMUTABLE version 1 (status 'published'): once seeded, rules deny
// edits to a published version, and jobs PIN { templateId, version } so an
// assessment never shifts shape mid-flight.
//
// Built from the same small factories as pas79Template.ts so the structure stays
// maintainable and ids are deterministic and stable once published.
// ============================================================================

import type {
  Template,
  TemplateQuestion,
  TemplateSection,
  SectionCode,
  QuestionType,
  QuestionMatrix,
} from '../../shared/types';
import { BS9792_TEMPLATE_VERSION } from '../ids';

// --- Question factories ------------------------------------------------------
// Each takes the section code so question ids are unique and stable across the
// whole template (e.g. `q-08-fixed-installation-testing`). Ids must never change
// once published, so they are derived deterministically from a slug.

interface QuestionOpts {
  options?: string[];
  matrix?: QuestionMatrix;
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
  if (opts.matrix) q.matrix = opts.matrix;
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

// Common option sets reused across the form.
const NA_YES_NO = ['Not applicable', 'Yes', 'No'];

// --- 01 General Information ---------------------------------------------------
// BS 9792-specific assessment metadata that is NOT held elsewhere in the record.
// The responsible person, Article 5(3) duty-holders, premises address, assessor
// identity and the assessment / validation / previous / review dates that head
// the BS 9792 form are owned by the building record, the assessment's chosen
// responsible party (the app's dedicated Responsible-Party editor, which defaults
// from the building and pre-fills every action) and the assessment workflow. The
// report renders that header block from those single sources of truth, so they
// are deliberately NOT re-asked here - re-typing them would create a second,
// divergeable source of truth for a production safety record.
const SECTION_01 = section('01', 'General Information', [
  makeQuestion(
    '01',
    'fra-type',
    'select',
    'Type of fire risk assessment',
    'Type 1 (communal areas, non-intrusive) is the minimum required for compliance with the Fire Safety Order. Types 2-4 add intrusive inspection and/or inspection of flats where there are concerns regarding compartmentation or means of escape.',
    {
      options: [
        'Type 1 - Communal areas, non-intrusive',
        'Type 2 - Communal areas, intrusive (sample basis)',
        'Type 3 - Communal areas and flats (means of escape and AFD)',
        'Type 4 - Communal areas and flats, intrusive (sample basis)',
      ],
      required: true,
    },
  ),
  makeQuestion(
    '01',
    'persons-consulted',
    'text',
    'Person(s) consulted',
    'Record who was consulted during the assessment (e.g. managing agent, caretaker, residents). The responsible person, Article 5(3) duty-holders, premises address, assessor and the assessment dates are taken from the building record, the assigned responsible party and the assessment itself - they are not re-entered here.',
  ),
]);

// --- 02 The Premises ---------------------------------------------------------
const SECTION_02 = section('02', 'The Premises', [
  makeQuestion(
    '02',
    'floor-area',
    'text',
    '1.1 Approximate floor area (gross), m²',
    'Record the approximate gross internal floor area of the building in square metres.',
    { required: true },
  ),
  makeQuestion(
    '02',
    'number-of-floors',
    'longtext',
    '1.2 Number of floors: (i) at ground level and above; (ii) entirely below ground level; (iii) on which car parking is provided',
    'State the number of storeys above ground, any basement storeys, and any floors on which car parking is provided.',
    { required: true },
  ),
  makeQuestion(
    '02',
    'number-of-flats',
    'text',
    '1.3 Number of flats',
    'Total number of dwellings within the building.',
  ),
  makeQuestion(
    '02',
    'construction-age',
    'longtext',
    '1.4 Brief details of construction and approximate age of the building',
    'Describe the form of construction and the approximate age. Age can be a factor when considering external walls, but note combustible materials may have been added over time.',
  ),
  makeQuestion(
    '02',
    'escape-stairs',
    'text',
    '1.5 Number and type of escape stairs',
    'Record the number and type of escape stairs serving the building (e.g. single protected stair, external stair).',
  ),
  makeQuestion(
    '02',
    'lifts',
    'text',
    '1.6 Number and type of lift',
    'Record the number and type of any lifts, including firefighting or evacuation lifts.',
  ),
  makeQuestion(
    '02',
    'premises-type',
    'multiselect',
    '1.7 Type of premises',
    'Select all descriptions that apply. The building type influences the applicable guidance and the required standard of fire precautions.',
    {
      options: [
        'General needs',
        'Maisonettes',
        'Sheltered housing',
        'Supported housing / assisted living',
        'Houses in multiple occupation',
        'Extra care',
      ],
    },
  ),
  makeQuestion(
    '02',
    'other-matters',
    'longtext',
    '1.8 Other matters that may be relevant',
    'Include, for example, hours of work or working practices, tenure of flats if known, and management arrangements (e.g. no regular presence on site). Note the format may not apply to single-family dwellings, premises under construction, short-term lets, peer-to-peer lets, non-domestic premises or residential care homes.',
  ),
]);

// --- 03 The Occupants --------------------------------------------------------
const SECTION_03 = section('03', 'The Occupants', [
  makeQuestion(
    '03',
    'employees',
    'text',
    '2.1 Approximate maximum number of employees at any one time',
    'Give the realistic peak number of employees present at any one time.',
  ),
  makeQuestion(
    '03',
    'residents-visitors',
    'text',
    '2.2 Approximate maximum number of residents and visitors at any one time',
    'Give the realistic peak number of residents and visitors present at any one time.',
  ),
]);

// --- 04 Occupants Especially at Risk from Fire -------------------------------
const SECTION_04 = section('04', 'Occupants Especially at Risk from Fire', [
  makeQuestion(
    '04',
    'sleeping-occupants',
    'yesno',
    '3.1 Are there sleeping occupants?',
    'Sleeping occupants are a significant risk factor and raise the required standard of detection and warning.',
    { required: true },
  ),
  makeQuestion(
    '04',
    'remote-lone-workers',
    'yesno',
    '3.2 Are there occupants in remote areas and lone workers?',
    'Consider persons who may be isolated and slower to become aware of a fire or to raise the alarm.',
  ),
  makeQuestion(
    '04',
    'mobility-impairment',
    'yesno',
    '3.3 Are there occupants with mobility impairment?',
    'It is not sufficient to record the presence of disabled people without reference to the nature of their disabilities.',
  ),
  makeQuestion(
    '04',
    'pcfra-carried-out',
    'yesno',
    '3.4 Has the appropriate person carried out a person-centred fire risk assessment (PCFRA)?',
    'Social housing and support providers should use PCFRAs to identify residents at higher risk and understand their risk profile, so suitable mitigation can be put in place.',
    { required: true },
  ),
  makeQuestion(
    '04',
    'other-at-risk',
    'longtext',
    '3.5 Other persons especially at risk',
    'Record any other groups especially at risk and the nature of the risk.',
  ),
  makeQuestion(
    '04',
    'pcfra-shortfall',
    'nonConformity',
    '3.4 Person-centred fire risk assessments (PCFRAs) for vulnerable residents',
    'Obs: A PCFRA has not been carried out for the more vulnerable residents. Rec: Carry out PCFRAs to identify those at greater risk and understand their risk profile - considering how a person’s characteristics, behaviour and capabilities affect the likelihood of fire and their ability to respond - then introduce suitable measures to mitigate the risks.',
    { allowsPhotos: true },
  ),
]);

// --- 05 Fire Loss Experience -------------------------------------------------
const SECTION_05 = section('05', 'Fire Loss Experience', [
  makeQuestion(
    '05',
    'fire-loss-recorded',
    'select',
    '4 Has the premises recorded any fire loss incidents?',
    'Past incidents, including false alarms and near misses, should inform this assessment.',
    {
      options: [
        'No fire loss incidents recorded',
        'Fire loss incident(s) recorded - see comments',
      ],
    },
  ),
  makeQuestion(
    '05',
    'fire-loss-details',
    'longtext',
    '4 Details of any recorded fire loss incidents',
    'Where incidents have occurred, record the details and any lessons learned.',
  ),
]);

// --- 06 Other Relevant Information -------------------------------------------
const SECTION_06 = section('06', 'Other Relevant Information', [
  makeQuestion(
    '06',
    'other-information',
    'longtext',
    '5 Other relevant information',
    'Record any further information relevant to the fire risk assessment not captured elsewhere.',
  ),
]);

// --- 07 Relevant Fire Safety Legislation -------------------------------------
const SECTION_07 = section('07', 'Relevant Fire Safety Legislation', [
  makeQuestion(
    '07',
    'legislation-applies',
    'longtext',
    '6.1 The following fire safety legislation applies to these premises',
    'The Building Safety Act 2022 amends the Fire Safety Order to add detailed provisions about the responsibilities of Responsible Persons - including that all Responsible Persons must record their completed fire risk assessment and fire safety arrangements in full.',
  ),
  makeQuestion(
    '07',
    'enforcing-authority',
    'text',
    '6.2 The above legislation is enforced by (name of fire authority)',
    'Name the enforcing fire and rescue authority.',
  ),
  makeQuestion(
    '07',
    'other-legislation',
    'longtext',
    '6.3 Other legislation making significant requirements for fire precautions (other than the Building Regulations 2010, as amended)',
    'Record any other legislation imposing significant fire precaution requirements at these premises.',
  ),
  makeQuestion(
    '07',
    'other-enforced-by',
    'text',
    '6.4 The other legislation referred to above is enforced by',
    'Name the authority enforcing any other relevant legislation.',
  ),
  makeQuestion(
    '07',
    'alterations-notice',
    'yesno',
    '6.5 Is there an alterations notice in force?',
    'Confirm whether an alterations notice is in force for the premises.',
  ),
  makeQuestion(
    '07',
    'prohibition-notice',
    'yesno',
    '6.5 Is there a prohibition or enforcement notice in force?',
    'Confirm whether a prohibition or enforcement notice is in force for the premises.',
  ),
  makeQuestion(
    '07',
    'assessor-summary',
    'longtext',
    'Risk assessor’s summary',
    'Provide a written exposition summarising the key points of the assessment.',
    { required: true },
  ),
]);

// --- 08 Electrical Sources of Ignition ---------------------------------------
const SECTION_08 = section('08', 'Electrical Sources of Ignition', [
  makeQuestion(
    '08',
    'measures-electrical',
    'yesno',
    '7.1 Are reasonable measures taken to prevent fires of electrical origin?',
    'Consider inspection and testing of fixed and portable equipment, avoidance of overloading, and safe siting of installations.',
    { required: true },
  ),
  makeQuestion(
    '08',
    'fixed-installation-testing',
    'nonConformity',
    '7.2 a) Periodic inspection and testing of the fixed electrical installation',
    'Obs: No evidence that the fixed electrical installation has been tested in accordance with BS 7671. Rec: Periodically test the fixed installation in accordance with BS 7671 (18th Edition, 2018); an Electrical Installation Condition Report (EICR) issued by a qualified electrician confirms compliance. Test frequency depends on installation type, use and environment.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'pat-testing',
    'nonConformity',
    '7.2 b) Portable appliance testing (PAT)',
    'Obs: No evidence that PAT has recently been undertaken. Rec: PAT should be undertaken by a competent person in line with HSE guidance, at a frequency assessed by reference to the risk, and a central register kept.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'extension-leads',
    'nonConformity',
    '7.2 c) Inappropriate use of extension leads / multi-point adaptors',
    'Obs: Electrical extension leads / multi-point adaptors are being used inappropriately. Rec: Use extension leads within their current rating and never overload them; use one extension lead per socket and never daisy-chain; fully unwind drum-type reels before use; use multi-socket leads rather than block adaptors.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'unprotected-stairway',
    'nonConformity',
    '7.2 d) Unprotected electrical installations within a protected stairway',
    'Obs: Unprotected electrical installations are sited within a protected stairway. Rec: Protected stairways are critical escape routes and should be kept free of risk. Enclose electrical installations in fire-resisting construction with appropriate signage.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'fixed-heating',
    'nonConformity',
    '7.2 e) Fixed heating system not in safe working order',
    'Obs: No evidence the fixed heating system is maintained per the manufacturer’s instructions. Rec: For all fixed systems, whatever the fuel, put service contracts in place and have servicing carried out by a competent person to keep them in safe and efficient operation.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'tumble-dryer',
    'nonConformity',
    '7.2 f) Tumble dryers not cleaned and serviced per manufacturer’s instructions',
    'Obs: Evidence the tumble dryer is not being cleaned or serviced per the manufacturer’s instructions. Rec: Carry out regular maintenance and clean filters of fluff, lint and debris; watch for warning signs (burning smell, longer drying times, hot items); never run appliances unattended or overnight.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'pv-installed',
    'yesno',
    '7.2 g) Are photovoltaic (PV) array systems installed?',
    'Record whether PV arrays are installed, as they introduce specific fire and firefighter-safety considerations.',
  ),
  makeQuestion(
    '08',
    'pv-isolation',
    'yesno',
    '7.2 h) Are there appropriately sited facilities for electrical isolation of any PV cells, with appropriate signage, to assist the fire and rescue service?',
    'A readily accessible “fire service switch” should be provided on each installation to isolate the DC side of the PV system near the panels, and be tested during routine maintenance with results recorded.',
  ),
  makeQuestion(
    '08',
    'pv-management',
    'nonConformity',
    '7.2 g) Photovoltaic system not managed or installed correctly',
    'Obs: Evidence the PV system is not managed or installed correctly. Rec: PV installations should be serviced and maintained per the installer’s instructions and warranty; confirm panels conform to BS EN 61215/61646 with BS EN 61730. PV panels and unprotected cables must not cross a fire compartment wall; control units should be in cabinets giving at least 60 minutes’ fire resistance and kept clear of storage.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '08',
    'pv-isolation-shortfall',
    'nonConformity',
    '7.2 h) Isolation facilities for the fire and rescue service not provided',
    'Obs: No appropriately sited facilities, with appropriate signage, to isolate the PV installation for the fire and rescue service. Rec: Provide a readily accessible “fire service switch” on each installation to isolate the DC side of the PV system near the panels, with clear signage. The isolation switch should be tested during routine maintenance visits and the results recorded.',
    { allowsPhotos: true },
  ),
]);

// --- 09 Gas Installation -----------------------------------------------------
const SECTION_09 = section('09', 'Gas Installation', [
  makeQuestion(
    '09',
    'mains-gas',
    'yesno',
    '8 Are there mains gas supplies connected?',
    'Record whether a mains gas supply is connected to the premises.',
  ),
  makeQuestion(
    '09',
    'gas-inspection',
    'nonConformity',
    '8.2 a) Periodic inspection and testing of fixed gas installations',
    'Obs: No record of appropriate servicing and maintenance of the fixed gas installations. Rec: Gas installations, boilers and appliances should be periodically inspected and maintained by a competent Gas Safe engineer in accordance with the Gas Safety (Installation and Use) Regulations 1998, and records kept.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '09',
    'temporary-gas-appliances',
    'nonConformity',
    '8.2 b) Temporary gas heating appliances inappropriately used/sited',
    'Obs: Temporary gas heating appliances are inappropriately used or sited. Rec: Use temporary heating appliances only per the manufacturer’s instructions; relocate or remove them. Check with insurers, who may restrict the types permitted.',
    { allowsPhotos: true },
  ),
]);

// --- 10 Smoking --------------------------------------------------------------
const SECTION_10 = section('10', 'Smoking', [
  makeQuestion(
    '10',
    'measures-smoking',
    'select',
    '9.1 Are reasonable measures taken to prevent fires as a result of smoking?',
    'Consider whether a smoking policy is in place, observed, and supported by suitable arrangements for those who wish to smoke.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '10',
    'smoking-prohibited',
    'yesno',
    '9.2 a) Is smoking prohibited in appropriate areas?',
    'A carefully monitored no-smoking policy, restricting smoking to a designated external area compliant with current regulations, reduces the incidence of fires. Display "No Smoking" signs clearly throughout.',
  ),
  makeQuestion(
    '10',
    'smoking-arrangements',
    'yesno',
    '9.2 b) Are there suitable arrangements for those who wish to smoke?',
    'Provide an adequate, identified external smoking area with fixed/heavy-based ashtrays or cigarette disposal units emptied regularly. Shelters should be at least 50% open at the walls (excluding doors/windows).',
  ),
  makeQuestion(
    '10',
    'smoking-policy-observed',
    'yesno',
    '9.2 c) Did the smoking policy appear to be observed at the time of inspection?',
    'The no-smoking policy statement should set out procedures for the premises and be reviewed at least every three years, or sooner if significant changes are needed.',
  ),
  makeQuestion(
    '10',
    'smoking-unauthorised',
    'nonConformity',
    '9.2 d) Evidence of unauthorised smoking on the premises',
    'Obs: Evidence of illicit smoking during the assessment, contrary to the smoking policy. Rec: Enforce the existing policy more rigidly or adapt it with further control measures, and convey this to all persons resorting to the premises.',
    { allowsPhotos: true },
  ),
]);

// --- 11 Arson ----------------------------------------------------------------
const SECTION_11 = section('11', 'Arson', [
  makeQuestion(
    '11',
    'measures-arson',
    'yesno',
    '10.1 Are reasonable measures taken to prevent fires as a result of arson?',
    'An arson risk assessment should form part of the fire risk assessment. Where specialist security advice is needed, it should be obtained from a security specialist.',
  ),
  makeQuestion(
    '11',
    'fire-load-proximity',
    'nonConformity',
    '10.2 a) Unnecessary fire load close to the premises or available for ignition by outsiders',
    'Obs: There is an unnecessary fire load close to the premises or available for ignition by outsiders. Rec: Lock away or dispose of flammable materials such as oils, fuels, wood and gas bottles; make regular checks and remove accumulated combustibles from around buildings.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '11',
    'arson-policy',
    'nonConformity',
    '10.2 b) Potential for arson with no policy in place to limit the opportunity',
    'Obs: There is potential for arson and no policy in place to limit the opportunity. Rec: Produce an arson reduction policy; store refuse and flammable materials in a secure closed metal container positioned, where possible, at least 10 metres from buildings; make staff aware.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '11',
    'visitor-access-control',
    'nonConformity',
    '10.2 c) No visitor access control procedure in place',
    'Obs: A visitor access control procedure is not in place. Rec: Provide adequate visitor control, ideally via a single controlled entrance, so unauthorised visitors cannot wander unchecked and start fires in quieter areas; secure access and egress when necessary.',
    { allowsPhotos: true },
  ),
]);

// --- 12 Portable Heaters and Heating and Ventilation Installations -----------
const SECTION_12 = section(
  '12',
  'Portable Heaters and Heating and Ventilation Installations',
  [
    makeQuestion(
      '12',
      'control-portable-heaters',
      'select',
      '11.1 Is there satisfactory control over the use of portable heaters?',
      'The use of portable and transportable heaters should be sanctioned by a designated person and considered within the fire risk assessment. Fixed heating is safer than portable where permanent heating is required.',
      { options: NA_YES_NO },
    ),
    makeQuestion(
      '12',
      'heaters-prejudice-escape',
      'nonConformity',
      '11.2 a) Heating units located so as to prejudice the means of escape',
      'Obs: Heating units are in locations that will prejudice the means of escape. Rec: Remove portable heaters from escape routes, circulation areas and staircase enclosures - even for short periods.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '12',
      'heaters-maintenance',
      'nonConformity',
      '11.2 b) Portable electrical/gas heaters not used safely or suitably maintained',
      'Obs: Portable heaters appear to be in poor repair or poorly sited. Rec: Have heaters examined by a competent person and inspected regularly for damage; place on a level surface away from anything that could knock them over; include their use (and misuse) in the workplace risk assessment.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '12',
      'heaters-combustibles',
      'nonConformity',
      '11.2 c) Portable heaters sited too close to combustible materials',
      'Obs: Portable heaters are in use and sited too close to combustible materials. Rec: Re-site heaters at least two metres from combustible materials; do not leave them unattended; do not use them to dry clothing; turn off at the end of each period of use.',
      { allowsPhotos: true },
    ),
  ],
);

// --- 13 Cooking --------------------------------------------------------------
const SECTION_13 = section('13', 'Cooking', [
  makeQuestion(
    '13',
    'measures-cooking',
    'select',
    '12.1 Are reasonable measures taken to prevent fires as a result of cooking?',
    'Consider cleaning of filters and ductwork, and clear identification of the shutdown device for cooking ranges.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '13',
    'duct-cleaning',
    'nonConformity',
    '12.2 a) Filters/ductwork not cleaned regularly - build-up of combustible deposits',
    'Obs: Build-up of combustible deposits inside the ducting. Rec: Clean removable grease filters at least weekly and place the extraction ductwork on a maintenance contract that includes a deep clean at least every 12 months (more often depending on use, the risk assessment and insurance warranty).',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '13',
    'shutdown-device',
    'nonConformity',
    '12.2 b) Shutdown device for the cooking range not clearly indicated',
    'Obs: The manual shutdown switch for cooking appliances is not clearly indicated. Rec: Clearly indicate the shutdown device with a sign and make operators familiar with the location of isolators/shut-off valves and firefighting appliances.',
    { allowsPhotos: true },
  ),
]);

// --- 14 Lightning ------------------------------------------------------------
const SECTION_14 = section('14', 'Lightning', [
  makeQuestion(
    '14',
    'lps-present',
    'yesno',
    '13.1 Does the building have a lightning protection system (LPS)?',
    'If yes, record the date of the last inspection in the next question.',
  ),
  makeQuestion(
    '14',
    'lps-last-inspection',
    'text',
    '13.1 If yes, date of last inspection of the LPS',
    'An LPS should be inspected by a licensed professional to remain compliant with BS EN/IEC 62305.',
  ),
  makeQuestion(
    '14',
    'lightning-risk',
    'nonConformity',
    '13.2 a) The building may be at risk from lightning',
    'Obs: No evidence of a lightning protection system for a building that may be at risk. Rec: The Electricity at Work Regulations 1989 require businesses to protect installations and premises from lightning; consider an LPS compliant with BS EN/IEC 62305, with surge protection and periodic inspection by a licensed professional.',
    { allowsPhotos: true },
  ),
]);

// --- 15 Housekeeping ---------------------------------------------------------
const SECTION_15 = section('15', 'Housekeeping', [
  makeQuestion(
    '15',
    'housekeeping-adequate',
    'yesno',
    '14.1 Is the overall standard of housekeeping adequate?',
    'Poor housekeeping increases the fuel load and can obstruct escape routes. Assess the standard across the whole premises.',
    { required: true },
  ),
  makeQuestion(
    '15',
    'combustibles-ignition',
    'nonConformity',
    '14.2 a) Combustible materials not separated from ignition sources',
    'Obs: Unacceptable level of combustible storage in the vicinity of ignition sources. Rec: Keep ignition sources clear of combustible material; non-combustible partitioning, barriers or floor markings can help define hazardous areas.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '15',
    'accumulation-combustibles',
    'nonConformity',
    '14.2 b) Unnecessary accumulation or inappropriate storage of combustible materials',
    'Obs: Accumulation of rubbish, waste paper or other materials that could catch fire or be set alight. Rec: Implement an adequate housekeeping policy with periodic management inspections; dispose of waste into a designated bin store.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '15',
    'combustibles-escape-routes',
    'nonConformity',
    '14.2 c) Combustible materials stored in escape routes, circulation spaces or external perimeter',
    'Obs: Build-up of combustible materials in escape routes, circulation spaces or the external perimeter. Rec: Keep halls and walkways clear to allow safe evacuation and reduce arson opportunity - a clear escape route is a legal requirement.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '15',
    'meter-cupboards',
    'nonConformity',
    '14.2 d) Gas/electricity intake/meter cupboards not adequately secured or kept clear of combustibles',
    'Obs: Unacceptable combustible storage near electrical intake/distribution equipment, or such rooms not secured. Rec: Manage and monitor storage; keep any storage at least 1 metre from distribution boards; do not store combustibles in plant rooms, boiler rooms, attics, service voids/shafts or switch rooms.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '15',
    'floor-covering-trip',
    'nonConformity',
    '14.2 e) Floor covering presents a trip hazard',
    'Obs: Floor covering presents a trip hazard and requires repair or replacement. Rec: Floors and coverings should be suitable, maintained in good condition and free of trip hazards; fill holes and secure carpets and coverings in place.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '15',
    'mobility-scooter-policy',
    'select',
    '14.2 f) Is there a policy in place to manage the storage of mobility scooters and electric vehicles (e-bikes/e-scooters)?',
    'Landlords have a duty to keep common areas clear of combustible materials. Recommend house rules for tenants keeping e-bikes/scooters, signed with the tenancy agreement, and check insurance covers battery-fire damage.',
    { options: NA_YES_NO },
  ),
]);

// --- 16 Hazards Introduced by Outside Contractors and Building Works ---------
const SECTION_16 = section(
  '16',
  'Hazards Introduced by Outside Contractors and Building Works',
  [
    makeQuestion(
      '16',
      'control-contractors',
      'select',
      '15.1 Is there satisfactory control over works carried out in the building by contractors?',
      'The responsible person (often the main/principal contractor in control of the site) must keep the risk assessment up to date and control hazards introduced by works.',
      { options: NA_YES_NO },
    ),
    makeQuestion(
      '16',
      'contractors-awareness',
      'nonConformity',
      '15.2 a) Contractors unaware of fire safety arrangements and emergency procedures',
      'Obs: Contractors carrying out hazardous activities (hot work, fuels, flammable liquids, LPG) with potential to compromise the means of escape. Rec: Make contractors aware of fire safety measures and evacuation arrangements (ideally signed as understood) and implement a permit-to-work scheme for high-risk activities.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '16',
      'building-control-approval',
      'nonConformity',
      '15.2 b) Alterations carried out with no evidence of Building Control approval',
      'Obs: Material changes to the structure, design or use of the building with no evidence of Building Control approval. Rec: Review the fire risk assessment before works start, consider additional dangers introduced, and continuously monitor the impact on general fire precautions and means of escape.',
      { allowsPhotos: true },
    ),
  ],
);

// --- 17 Dangerous Substances -------------------------------------------------
const SECTION_17 = section('17', 'Dangerous Substances', [
  makeQuestion(
    '17',
    'precautions-dangerous-substances',
    'select',
    '16.1 Are the general fire precautions adequate to address the hazards of dangerous substances/materials used or stored?',
    'Small quantities with negligible impact on the appropriate fire precautions need not be taken into account. Consider a DSEAR assessment where relevant.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '17',
    'flammable-liquids-storage',
    'nonConformity',
    '16.2 a) Inadequate storage arrangements for flammable liquids',
    'Obs: Flammable liquids not stored separately from other dangerous substances, enhancing the risk of fire. Rec: Conduct a DSEAR assessment; observe separation distances (e.g. 2 m up to 1,000 L, 4 m up to 100,000 L, 7.5 m above) from occupied buildings, boundaries and ignition sources.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '17',
    'lpg-storage',
    'nonConformity',
    '16.2 b) Inadequate storage arrangements for LPG cylinders',
    'Obs: LPG not stored in an adequate location and not in accordance with relevant codes of practice. Rec: Consider the hazard and inventory when siting the store (distance from other materials, plant, traffic routes and occupied buildings) and address site-specific security and vandalism, per HSE guidance and I.S. 3213.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '17',
    'heating-oil',
    'nonConformity',
    '16.2 c) Inadequate/dangerous storage or use of heating oil',
    'Obs: Storage/use of heating oil is inadequate or dangerous. Rec: Follow the gov.uk oil-storage rules - which apply to containers of 201 L or more at businesses/public buildings, or 3,501 L or more at homes; the Environment Agency may serve an anti-pollution works notice.',
    { allowsPhotos: true },
  ),
]);

// --- 18 Flammable, Combustible Items and Other Dangerous Materials -----------
const SECTION_18 = section(
  '18',
  'Flammable, Combustible Items and Other Dangerous Materials',
  [
    makeQuestion(
      '18',
      'items-identified',
      'yesno',
      '17.1 Have all flammable, combustible items and other dangerous substances been identified and effective control measures put in place?',
      'Confirm identification of dangerous substances and materials and that control measures are in place.',
    ),
    makeQuestion(
      '18',
      'furniture-regs',
      'nonConformity',
      '17.2 a) Furniture does not comply with the Furniture and Furnishings (Fire) (Safety) Regulations',
      'Obs: Furniture does not comply with the Furniture and Furnishings Regulations. Rec: Ensure all upholstered furniture complies with the 1988 Regulations; curtains and textile hangings should be inherently flame retardant; repair or replace damaged items.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '18',
      'curtains-fire-retardant',
      'nonConformity',
      '17.2 b) Curtains and drapes not confirmed as treated with fire-retardant materials',
      'Obs: The assessor was unable to confirm that curtains/drapes were treated with fire-retardant materials; no certificates available. Rec: Replace with an inherently flame-retardant type or treat with a suitable fire retardant, with certification retained.',
      { allowsPhotos: true },
    ),
  ],
);

// --- 19 Fire Protection Measures - Construction ------------------------------
const SECTION_19 = section(
  '19',
  'Fire Protection Measures - Construction',
  [
    makeQuestion(
      '19',
      'compartmentation-adequate',
      'select',
      '18.1 Do the separating floors/walls/ceilings/glazing & stairs provide appropriate fire resistance and compartmentation?',
      'Passive fire protection subdivides the building into fire compartments to limit fire and smoke spread and protect the means of escape. This assessment may not identify all minor fire-stopping issues; an invasive survey by a competent specialist may be needed.',
      { options: NA_YES_NO, required: true, allowsFlagLocation: true },
    ),
    makeQuestion(
      '19',
      'separating-floors-walls',
      'nonConformity',
      '18.2 a) Separating floors/walls do not provide the necessary fire resistance/compartmentation',
      'Obs: The separating floors/walls do not provide the necessary degree of fire resistance. Rec: Upgrade or replace them to provide the required standard; every compartment floor should form a complete barrier and have the appropriate fire resistance (Approved Document B).',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'breaches-walls-ceiling',
      'nonConformity',
      '18.2 b) Breaches in fire-resisting walls/ceilings jeopardising escape or allowing fire spread',
      'Obs: Holes or gaps in the fire-resisting ceiling/walls with potential to jeopardise means of escape or cause unacceptable fire spread. Rec: In-fill holes/gaps by a competent person with materials providing the required fire resistance; replace non-compliant walls/partitions.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'services-penetrations',
      'nonConformity',
      '18.2 c) Pipework/other services penetrate fire-resisting walls/ceilings',
      'Obs: Pipework and/or services penetrate the fire-resisting ceiling/floor. Rec: Fire-stop around penetrations with materials providing the required fire resistance; keep penetrations as few and small as practicable; a full compartment survey is recommended.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'unable-ascertain-fr',
      'nonConformity',
      '18.2 d) Unable to ascertain whether floors/walls provide the necessary standard of fire resistance',
      'Obs: The assessor could not ascertain whether floors/walls (including above suspended ceilings and cross-corridor doors) provide the necessary fire resistance. Rec: Carry out a full fire compartmentation survey to review existing measures and identify breaches, voids and cavities.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'glazing-standard',
      'nonConformity',
      '18.2 e) Glazing to escape routes/staircases not of a suitable standard',
      'Obs: Glazing does not provide the necessary 30/60 minute period of fire resistance. Rec: Fire-resistant glass performs only as part of a complete fire-resistant glazed system; replace with a type providing the required standard.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'stairways-enclosed',
      'nonConformity',
      '18.2 f) Stairways required for means of escape not adequately enclosed',
      'Obs: Internal stairways required for means of escape are not adequately enclosed. Rec: Enclose protected stairways throughout their height in half-hour fire-resisting construction; doors should be FD30S with positive self-closing devices.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'stairways-final-exit',
      'nonConformity',
      '18.2 g) Stairways required for means of escape do not lead directly to a final exit',
      'Obs: Internal stairways required for escape do not lead directly to a final exit. Rec: Enclose the route from the foot of the stair to the final exit in fire-resisting construction, or provide separated alternative routes to a final exit.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'external-stairway',
      'nonConformity',
      '18.2 h) Provision of external stairway is unacceptable',
      'Obs: The suitability of the external escape stairway is in question. Rec: External stairs deteriorate through weather exposure; have a competent person confirm fitness for use. Doors giving access should be FD30 and self-closing (except at the uppermost level), per BS 9999 / Approved Document B.',
      { allowsFlagLocation: true, allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'roof-compartmentation',
      'nonConformity',
      '18.2 i) Cannot be determined whether there is reasonable compartmentation within the roof space',
      'Obs: Reasonable compartmentation within the roof space cannot be determined. Rec: Extend the compartment wall up to meet the underside of the roof covering (at least 375 mm above the adjoining roof) with fire-stopping at the junction; a full compartment survey is recommended.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'fire-dampers',
      'nonConformity',
      '18.2 j) Fire dampers not provided/serviced where necessary',
      'Obs: It cannot be confirmed that fire dampers are correctly installed or serviced. Rec: BS 9999 requires all dampers, regardless of type, to be tested at least annually (identify, inspect, drop-test, reset and report).',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'surface-spread-flame',
      'nonConformity',
      '18.2 k) Surface spread of flame classification of wall/ceiling linings is unacceptable',
      'Obs: The surface spread of flame classification for wall/ceiling coverings is unacceptable. Rec: Replace linings with materials achieving the required class (rooms up to 4 m² in residential accommodation should be Class 3) or apply a proprietary treatment to achieve the same standard.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'uninsulated-glazing',
      'nonConformity',
      '18.2 l) Uninsulated fire-resisting glazing installed below 1.1 metres',
      'Obs: Uninsulated fire-resisting glazing is installed below 1.1 metres. Rec: Replace glazing below 1.1 m with a type providing insulation properties, or with solid fire-resisting partitions.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '19',
      'separation-adjacent',
      'nonConformity',
      '18.2 m) Premises not adequately separated from the adjacent building',
      'Obs: The premises are not adequately separated from the adjacent building. Rec: Upgrade the separating walls to provide the requisite fire resistance (minimum 60 minutes) between adjoining dwellings/buildings.',
      { allowsPhotos: true },
    ),
  ],
);

// --- 20 Means of Escape ------------------------------------------------------
const SECTION_20 = section('20', 'Means of Escape', [
  makeQuestion(
    '20',
    'travel-distance-adequate',
    'select',
    '19.1 Is the design and maintenance of the means of escape such that travel distances to the nearest storey exit are within acceptable limits?',
    'Assess against the occupancy and building. Single-direction limits are typically 12/18/25 m (higher/normal/lower risk) and multi-direction 25/45/60 m.',
    { options: NA_YES_NO, required: true, allowsFlagLocation: true },
  ),
  makeQuestion(
    '20',
    'excessive-travel-distance',
    'nonConformity',
    '19.2 a) Excessive travel distance to the nearest storey exit',
    'Obs: Travel distance to the nearest storey exit is excessive. Rec: Provide an acceptable alternative escape route; where not feasible, automatic fire detection in the area(s) may adequately compensate for the extended travel distance.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'single-direction-travel',
    'nonConformity',
    '19.2 a.1) Single-direction escape exceeds the limits placed on travel in one direction',
    'Obs: Escape is in one direction only and the travel distance exceeds the limits for single-direction escape. Rec: Provide an acceptable alternative escape route; where not feasible, automatic fire detection may compensate for the extended travel distance.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'exits-provision',
    'nonConformity',
    '19.2 b) Provision of exits is inadequate',
    'Obs: Insufficient number of exits for the number of persons occupying the area. Rec: Provide an additional alternative exit or limit the numbers occupying the area. Where more than one exit is provided, routes should be independent with distinct escape routes.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'exit-direction',
    'nonConformity',
    '19.2 c) Fire exits do not open in the direction of escape where necessary',
    'Obs: A door used for escape by more than 60 persons does not open in the direction of escape. Rec: All doors on escape routes should open in the direction of escape; re-hang the door by a competent person. Sliding/revolving doors must not be used as fire exits.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'doors-staircase-fr',
    'nonConformity',
    '19.2 d) Fire resistance of doors to staircases/common areas not adequate or not maintained',
    'Obs: Doors to staircases and corridors serving sleeping/residential accommodation do not provide the requisite fire resistance. Rec: All such doors and partitions should give at least half-hour fire resistance; doors should be FD30S with positive self-closing devices, intumescent strips/smoke seals and three hinges.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'doors-meter-cupboards',
    'nonConformity',
    '19.2 e) Fire resistance of doors to meter cupboards/storerooms/plant rooms not adequate or not secured',
    'Obs: An unprotected electrical installation is sited within the escape route. Rec: Relocate to a more appropriate area, or enclose within a fire-resistant enclosure per Approved Document B or BS 9999; cupboard doors kept locked shut with appropriate signage.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'flat-entrance-doors',
    'nonConformity',
    '19.2 f) Fire resistance of flat entrance doors not adequate or not maintained',
    'Obs: Existing fire doors are not of the appropriate fire-resisting standard. Rec: Install door sets providing the required fire resistance, fitted with positive self-closing devices. Flat entrance doors onto communal areas are required to be fire doors.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'self-closing-devices',
    'nonConformity',
    '19.2 g) Suitable self-closing devices not fitted or not maintained',
    'Obs: The fire door(s) require a self-closing device. Rec: Fit suitable positive-action self-closing devices (BS EN 1154) to the fire doors indicated. All fire doors, except those to cupboards/service ducts kept locked shut, should be self-closing.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'smoke-control',
    'nonConformity',
    '19.2 h) No adequate smoke control to protect common escape routes where necessary',
    'Obs: The smoke control system protecting the means of escape is inadequate/defective. Rec: Smoke control systems should remove sufficient smoke to protect escape routes; mechanical ventilation should direct air movement away from protected routes and be readily testable and maintainable.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'routes-obstructions',
    'nonConformity',
    '19.2 i) Escape routes not clear of obstructions',
    'Obs: Escape routes were obstructed. Rec: Keep escape routes and exits clear and free of obstruction at all times; routes should generally be at least one metre wide and evaluated for the entire journey to a place of safety.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'exits-openable',
    'nonConformity',
    '19.2 j) Fire exits not easily and immediately openable with simple fastening',
    'Obs: A fire exit door is fitted with more than one fastening. Rec: Fit one approved emergency exit device (or thumb-turn) only; remove any second fastening, or implement a robust management procedure to ensure secondary locks are removed while occupied.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'disabled-evacuation',
    'nonConformity',
    '19.2 k) Arrangements for the evacuation of disabled people not adequate',
    'Obs: Insufficient reasonable arrangements for the evacuation of disabled persons. Rec: Review the evacuation policy and develop PEEPs for disabled people who use the building, in consultation with them; the plan must not rely on intervention by the fire and rescue service.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'fire-doors-wedged',
    'nonConformity',
    '19.2 l) Fire doors found wedged open',
    'Obs: Fire doors were found wedged open. Rec: Remove wedges and keep doors closed when not in use (this indicates a training need). Where a door must be held open, fit an approved automatic hold-open/release device (BS EN 1155 or BS 5839-3).',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'fire-door-gaps',
    'nonConformity',
    '19.2 m) Large gaps between fire doors and frames impairing intumescent seals',
    'Obs: Large gaps between doors and frames may prevent intumescent seals being effective. Rec: Adjust doors so gaps do not exceed 3 mm at the hinge edge, leading edge and top (for FD30S cold-smoke control), or fit a threshold smoke seal.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'fire-doors-heavy-use',
    'nonConformity',
    '19.2 n) Fire doors in corridors subject to very heavy use and rapid deterioration',
    'Obs: Fire doors in corridors are subject to very heavy use, causing rapid deterioration. Rec: Consider holding corridor doors open on automatic hold-open devices linked to the fire alarm and detection system.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '20',
    'means-of-escape-photo',
    'photo',
    'Photograph the principal means of escape',
    'Capture a clear image of the protected route, stair and final exit to evidence provision and condition.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
]);

// --- 21 External Cladding (PAS 9980) -----------------------------------------
const SECTION_21 = section('21', 'External Cladding (PAS 9980)', [
  makeQuestion(
    '21',
    'fraew-warranted',
    'select',
    '20.2 Is the building such that the risk of external fire spread warrants a Fire Risk Appraisal of External Walls (FRAEW)?',
    'A FRAEW is not required for all blocks; for traditional masonry construction, or where it can be readily determined that no FRAEW is necessary, the assessor addresses external wall compliance within the FRA. Care is needed where combustible materials may have been added over time.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '21',
    'combustible-external-walls',
    'nonConformity',
    '20.2 a) Potentially combustible external wall materials/insulation/systems with no evidence of certification',
    'Obs: External wall materials, insulation, components or configurations are potentially combustible (full or partial). Rec: Have the external cladding and fixings examined to establish factual information on materials, components and construction; persons conducting FRAEWs must be competent to do so.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '21',
    'cavities-closed',
    'nonConformity',
    '20.2 b) Unable to ascertain whether cavities are closed at compartment lines, openings and services',
    'Obs: Unable to ascertain if cavities are closed at compartment floors/walls, around windows/openings or at ventilation ducts/services. Rec: Include the type, location and condition of cavity barriers in the FRAEW; a fire compartmentation survey is recommended.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '21',
    'cavity-barriers',
    'nonConformity',
    '20.2 c) Cavity barriers present but potentially ineffective through poor installation/maintenance',
    'Obs: Inspection was non-intrusive; cavity barriers could not be confirmed as present or effective. Rec: Cavity barriers close the edges of cavities and around openings; critical areas should be checked (this is difficult without intrusive inspection) and as-built/maintenance information collated as part of the golden thread.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '21',
    'balconies',
    'nonConformity',
    '20.2 d) Balconies/terraces adjacent to combustible construction or of combustible materials',
    'Obs: Balcony/terrace construction and use present an increased risk. Rec: Undertake a fire risk assessment accounting for construction materials and use; consider adjacent combustible cladding, coverings, gutters/soffits and combustible/living roofs, and prohibit high-risk activities (barbecues, heaters, firepits, smoking, candles) by policy.',
    { allowsPhotos: true },
  ),
]);

// --- 22 Emergency Escape Lighting --------------------------------------------
const SECTION_22 = section('22', 'Emergency Escape Lighting', [
  makeQuestion(
    '22',
    'escape-lighting-adequate',
    'select',
    '21.1 Has a reasonable standard of emergency escape lighting been provided?',
    'Based on visual inspection only. An escape lighting system should conform to BS EN 1838 and BS 5266 Part 1.',
    { options: NA_YES_NO, required: true, allowsFlagLocation: true },
  ),
  makeQuestion(
    '22',
    'lighting-damaged',
    'nonConformity',
    '21.2 a) Existing escape lighting system damaged/defective',
    'Obs: The existing escape lighting system is damaged/defective. Rec: Have the system checked and repaired by a competent electrical engineer to conform to BS 5266 Part 1.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '22',
    'no-lighting-system',
    'nonConformity',
    '21.2 b) No escape lighting system in place',
    'Obs: There is no escape lighting system in place. Rec: Provide an emergency lighting system independent of other systems, illuminating all escape routes, larger rooms and exit/directional signs, designed and installed by a competent person to BS 5266 Part 1.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '22',
    'lighting-deficient',
    'nonConformity',
    '21.2 c) Existing escape lighting deficient in parts of the premises',
    'Obs: The existing system is deficient in parts of the premises and does not provide adequate illumination. Rec: Have a competent person survey internally and externally and upgrade the system to the minimum illuminance levels of BS EN 1838 and BS 5266 Part 1.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '22',
    'external-lighting',
    'nonConformity',
    '21.2 d) External escape lighting insufficient to illuminate routes to the assembly point',
    'Obs: External escape lighting appears insufficient to illuminate the external routes to the rendezvous points. Rec: Provide sufficient escape lighting to the assembly point via all exterior exit routes, unless adequate borrowed lighting can be demonstrated.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '22',
    'windowless-lighting',
    'nonConformity',
    '21.2 e) Underground or windowless accommodation not provided with escape lighting',
    'Obs: Underground or windowless accommodation is not provided with escape lighting. Rec: Provide a system conforming to BS EN 1838 and BS 5266 Part 1 following a survey by a competent person.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '22',
    'lighting-photo',
    'photo',
    'Photograph a representative emergency lighting unit',
    'Capture a unit on the escape route to evidence provision.',
    { allowsPhotos: true },
  ),
]);

// --- 23 Fire Safety Signs and Notices ----------------------------------------
const SECTION_23 = section('23', 'Fire Safety Signs and Notices', [
  makeQuestion(
    '23',
    'signs-adequate',
    'select',
    '22.1 Are there adequate and suitable fire safety signs and notices displayed in appropriate places throughout the premises?',
    'Signs should comply with the Health and Safety (Safety Signs and Signals) Regulations 1996 and BS 5499.',
    { options: NA_YES_NO, allowsFlagLocation: true },
  ),
  makeQuestion(
    '23',
    'keep-shut-sign',
    'nonConformity',
    '22.2 a) Fire door(s) not provided with "Fire Door Keep Shut" sign',
    'Obs: Fire door(s) not provided with a "Fire Door Keep Shut" sign. Rec: Provide compliant signs (Health and Safety (Safety Signs and Signals) Regulations 1996 and BS 5499) so fire doors are identified and kept shut.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'keep-locked-sign',
    'nonConformity',
    '22.2 b) Fire door(s) not provided with "Fire Door Keep Locked" sign',
    'Obs: Fire door(s) not provided with a "Fire Door Keep Locked" sign. Rec: Provide compliant mandatory signs on doors required to be kept locked (Regulations 1996 and BS 5499).',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'push-bar-sign',
    'nonConformity',
    '22.2 c) Emergency egress device on final exit not identified with "Push Bar/Pad to Open" sign',
    'Obs: The emergency egress opening device is not adequately identified. Rec: Provide a "Push Bar/Pad to Open" sign on final exit doors fitted with a panic bar/pad, complying with the Regulations 1996 and BS 5499.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'fire-exit-sign',
    'nonConformity',
    '22.2 d) Final exit door(s) not provided with "Fire Exit" sign',
    'Obs: Final exit door(s) not provided with appropriate signage. Rec: Provide fire exit signs (pictogram of a person running through a door with the words "Fire Exit") complying with the Regulations 1996 and BS 5499.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'directional-signs',
    'nonConformity',
    '22.2 e) Directional fire exit signs not provided or insufficient',
    'Obs: Directional fire exit signs are not provided, inappropriately located or inadequate. Rec: Provide directional signs at every change of direction/level so persons can identify exit routes from any part of the premises; suspend from the ceiling where necessary.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'keep-clear-sign',
    'nonConformity',
    '22.2 f) External side of final exit not provided with "Fire Exit Keep Clear" sign',
    'Obs: The external side of the final exit is not adequately identified. Rec: Provide a "Fire Exit Keep Clear" sign on the external face where the door may be obstructed; consider bollards or hatched paint outside the final exit.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'fire-action-notices',
    'nonConformity',
    '22.2 g) No Fire Action notices in place, or not sufficient for the layout',
    'Obs: No Fire Action notices in place or insufficient for the premises layout. Rec: Provide Fire Action Notices (action on discovering a fire, assembly point, building-specific instructions) next to fire alarm call points and at every final exit door.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '23',
    'signage-photo',
    'photo',
    'Photograph representative fire safety signage',
    'A photograph of signage on a main escape route evidences provision and condition.',
    { allowsPhotos: true },
  ),
]);

// --- 24 Means of Giving Warning in Case of Fire ------------------------------
const SECTION_24 = section('24', 'Means of Giving Warning in Case of Fire', [
  makeQuestion(
    '24',
    'alarm-adequate',
    'select',
    '23.1 Is there an adequate method of raising the alarm and detecting a fire, compatible with the evacuation strategy?',
    'Detection and warning should suit the building, its use and its occupants. Where people sleep, inadequate detection is a serious finding.',
    { options: NA_YES_NO, required: true, allowsFlagLocation: true },
  ),
  makeQuestion(
    '24',
    'alarm-method-unsuitable',
    'nonConformity',
    '23.2 a) Method of raising the alarm currently in use is unsuitable',
    'Obs: The method of raising the alarm is unsuitable. Rec: Design, install and commission an electrical manual fire alarm system to BS 5839-1 by a competent certificated organisation.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'afd-not-suitable',
    'nonConformity',
    '23.2 b) Automatic fire detection not suitable/sufficient for the risks, size or layout',
    'Obs: The automatic fire detection is not suitable and sufficient for the risks or the size/layout. Rec: Design, install and commission an AFD system to BS 5839-6 or -1 by a competent certificated organisation.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'afd-insufficient',
    'nonConformity',
    '23.2 c) Automatic fire detection insufficient for the risk, occupancy or layout',
    'Obs: The AFD system appears insufficient for the risk, occupancy and/or layout. Rec: Have the existing system surveyed by a competent certificated organisation and upgraded to the appropriate category to BS 5839-6 or -1.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'l1-detection-missing',
    'nonConformity',
    '23.2 d) L1 system provided but automatic detection missing in parts of the premises',
    'Obs: An L1 system is provided but automatic detection is missing in parts of the premises. Rec: An L1 standard requires detection to means of escape, all habitable rooms, stores, plant/boiler/tank rooms, electrical cupboards and roof voids; install missing detectors, linked to the main alarm, by a competent engineer to BS 5839.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'detector-covered',
    'nonConformity',
    '23.2 e) Automatic smoke detection found covered',
    'Obs: Automatic smoke detection was found covered, preventing correct operation. Rec: Detectors must not be covered - remove any covers immediately. Tampering with detection may be a criminal offence.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'insufficient-call-points',
    'nonConformity',
    '23.2 f) Insufficient fire alarm call points provided',
    'Obs: Insufficient fire alarm call points provided. Rec: Provide additional call points on escape routes near exits, on each floor, no more than 30 m from any point, no higher than 1.4 m above the floor (BS 5839).',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'call-points-obscured',
    'nonConformity',
    '23.2 g) Fire alarm call points obscured',
    'Obs: Fire alarm break-glass call points are obscured. Rec: Remove obstructions; call points must be readily available and accessible at all material times.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'no-zone-plan',
    'nonConformity',
    '23.2 h) No fire alarm zone plan provided',
    'Obs: No fire alarm zone plans available. Rec: Under BS 5839-1:2017 provide an accurate, up-to-date zone plan (showing escape routes, circulation areas, exits and stairs) located by the fire alarm panel to save time during activations.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '24',
    'false-alarm-records',
    'nonConformity',
    '23.2 i) No relevant information/records on false alarm experience',
    'Obs: History shows a significant number of unwanted fire signals, or no records are kept. Rec: The Responsible Person must manage false alarms; keep a record of false alarms as part of the fire safety logbook (BS 5839-1).',
    { allowsPhotos: true },
  ),
]);

// --- 25 Manual Fire Extinguishing Appliances ---------------------------------
const SECTION_25 = section('25', 'Manual Fire Extinguishing Appliances', [
  makeQuestion(
    '25',
    'extinguishers-adequate',
    'select',
    '24.1 Is there reasonable provision of manual fire extinguishing appliances, correctly sited and adequately maintained?',
    'Extinguishers should suit the risks present and be sited, maintained and provided in accordance with BS 5306.',
    { options: NA_YES_NO, allowsFlagLocation: true },
  ),
  makeQuestion(
    '25',
    'insufficient-equipment',
    'nonConformity',
    '24.2 a) Insufficient portable fire-fighting equipment provided',
    'Obs: Insufficient portable fire-fighting equipment provided. Rec: Provide additional equipment in the positions indicated by a competent person to BS 5306-8 (e.g. for a storey up to 400 m², at least two Class A extinguishers totalling 26A minimum).',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '25',
    'equipment-siting',
    'nonConformity',
    '24.2 b) Portable fire-fighting equipment not correctly sited',
    'Obs: Equipment is not correctly sited. Rec: Site to BS 5306-8, wall-mounted with the handle no more than 1.0 m (over 4 kg) or 1.5 m (up to 4 kg) above the floor, or on a designated stand.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '25',
    'equipment-standards',
    'nonConformity',
    '24.2 c) Portable fire-fighting equipment does not conform to current standards',
    'Obs: Equipment does not conform to current standards. Rec: Equipment should conform to BS EN 3-7 or BS 5306-8 and be purchased from and maintained by a competent certificated organisation.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '25',
    'equipment-obstructed',
    'nonConformity',
    '24.2 d) Fire extinguishing appliances not readily accessible',
    'Obs: Equipment is obstructed. Rec: Clear obstructions and ensure equipment is unobstructed and available for immediate use at all material times; do not conceal behind doors, in cupboards or where a fire could prevent access.',
    { allowsFlagLocation: true, allowsPhotos: true },
  ),
  makeQuestion(
    '25',
    'extinguisher-photo',
    'photo',
    'Photograph the fire extinguisher provision',
    'A clear image of the equipment and its location supports the report and confirms accessibility.',
    { allowsPhotos: true },
  ),
]);

// --- 26 Relevant Automatic Fire Extinguishing Systems ------------------------
const SECTION_26 = section(
  '26',
  'Relevant Automatic Fire Extinguishing Systems',
  [
    makeQuestion(
      '26',
      'fixed-system-type',
      'longtext',
      '25.1 Type of fixed system and areas covered',
      'Where automatic fire suppression is fitted, indicate the type of system and the areas covered, plus other relevant fire protection systems and facilities to assist firefighters. (Relevant to life safety, as opposed to property protection.)',
    ),
    makeQuestion(
      '26',
      'sprinklers',
      'select',
      '25.2 a) Sprinklers',
      'Record whether a sprinkler system is provided.',
      { options: NA_YES_NO },
    ),
    makeQuestion(
      '26',
      'extinguishing-systems',
      'select',
      '25.2 b) Extinguishing systems',
      'Record whether other fixed extinguishing systems are provided.',
      { options: NA_YES_NO },
    ),
    makeQuestion(
      '26',
      'pav-voice-systems',
      'select',
      '25.2 c) PA/VA voice systems',
      'Record whether a public-address / voice-alarm system is provided.',
      { options: NA_YES_NO },
    ),
    makeQuestion(
      '26',
      'engineered-system-maintenance',
      'nonConformity',
      '25.2 Engineered systems not maintained in accordance with manufacturer instructions',
      'Obs: Engineered systems are not maintained in accordance with manufacturer instructions. Rec: Seek verification that the system is maintained in accordance with the design specification and maintenance schedule.',
      { allowsPhotos: true },
    ),
  ],
);

// --- 27 Facilities and Arrangements for Firefighters -------------------------
const SECTION_27 = section(
  '27',
  'Facilities and Arrangements for Firefighters',
  [
    makeQuestion(
      '27',
      'facilities-maintained',
      'select',
      '26.1 Have all systems, equipment and facilities for use by the fire and rescue service been suitably maintained, identified and made accessible?',
      'The Responsible Person must maintain facilities provided for firefighters in efficient working order and good repair.',
      { options: NA_YES_NO, allowsFlagLocation: true },
    ),
    makeQuestion(
      '27',
      'access-firefighters',
      'nonConformity',
      '26.2 a) Reasonable facilities and access for firefighters and appliances not provided',
      'Obs: Reasonable facilities and access for firefighters and fire appliances have not been provided. Rec: Make urgent arrangements for access in accordance with Section 16 of Approved Document B / the Building Regulations 2010 (B5).',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '27',
      'safeguard-firefighters',
      'nonConformity',
      '26.2 b) Reasonable measures not made to safeguard firefighting personnel',
      'Obs: Reasonable measures/arrangements to safeguard firefighting personnel are not in place (e.g. overhead cabling inadequately supported; no external warning signs for hazardous materials). Rec: Survey and secure cabling against early failure, and provide external warning signs indicating the type and location of highly flammable, flammable, explosive or oxidising materials.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '27',
      'water-supplies',
      'nonConformity',
      '26.2 c) Adequate water supplies not provided for firefighting',
      'Obs: Adequate water supplies for firefighting have not been provided. Rec: Consult the local fire authority on the provision/location of water supplies; hydrants (min 8 l/s) should be clearly indicated (BS 3251) and private hydrants tested, inspected and maintained.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '27',
      'rising-mains',
      'nonConformity',
      '26.2 d) Rising mains not adequately provided',
      'Obs: Rising mains are not adequately provided to assist firefighting. Rec: Provide vehicle access for a pump appliance to small buildings (up to 2000 m² with top storey up to 11 m) to 15% of the perimeter or within 45 m (60 m with suppression) of every point, per Approved Document B.',
      { allowsPhotos: true },
    ),
    makeQuestion(
      '27',
      'evacuation-alert-system',
      'select',
      '26.2 e) Has an evacuation alert system for use by the fire and rescue service been installed (blocks of flats)?',
      'An evacuation alert system (EACIE) to BS 8629 is strongly recommended in England for buildings containing flats with a storey at 18 m or more, and is mandatory in Scotland. It is for fire-service use only and does not incorporate automatic detection.',
      { options: NA_YES_NO },
    ),
    makeQuestion(
      '27',
      'wayfinding-signage',
      'select',
      '26.2 f) Has wayfinding signage (floor level identification and flat directional signage) been installed?',
      'The Fire Safety (England) Regulations 2022 require wayfinding signage in residential buildings with a top storey more than 11 m above ground. Floor identification numerals should be at least 75 mm high (text at least 50 mm), mounted 1.7-2 m above floor level.',
      { options: NA_YES_NO },
    ),
  ],
);

// --- 28 Procedures and Arrangements ------------------------------------------
const SECTION_28 = section('28', 'Procedures and Arrangements', [
  makeQuestion(
    '28',
    'competent-person-appointed',
    'select',
    '27.1 Has the competent person appointed under Article 18 undertaken the preventive and protective measures?',
    'Article 18 of the Fire Safety Order requires the responsible person to appoint one or more competent persons to assist in undertaking the preventive and protective measures (they may nominate themselves).',
    { options: NA_YES_NO, required: true },
  ),
  makeQuestion(
    '28',
    'managed-by',
    'text',
    '27.2 a) Fire safety at the premises is managed by',
    'Record the name of the person responsible for managing fire safety at the premises.',
  ),
  makeQuestion(
    '28',
    'no-record-arrangements',
    'nonConformity',
    '27.2 b) No suitable record of the fire safety arrangements',
    'Obs: There is no suitable record of the fire safety arrangements. Rec: Prepare a fire safety arrangements policy document detailing the planning, organisation, control, monitoring and review of the preventive and protective measures.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '28',
    'evacuation-strategy',
    'select',
    '27.2 c) Evacuation strategy',
    'The type of evacuation strategy depends on the size and nature of the premises and its occupants. Common strategies are Stay Put, simultaneous evacuation, phased evacuation and staff-alarm (silent) evacuation.',
    {
      options: [
        'Stay Put',
        'Simultaneous evacuation',
        'Phased evacuation',
        'Other / not known',
      ],
    },
  ),
  makeQuestion(
    '28',
    'fire-procedures',
    'nonConformity',
    '27.2 d) Procedures in the event of fire not appropriate or properly documented',
    'Obs: The procedures in the event of fire are not appropriate and properly documented. Rec: Document and review procedures at least annually or after any incident; the three key actions are to raise the alarm, summon the fire brigade and evacuate (attempting to extinguish only if safe).',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '28',
    'peep-considered',
    'nonConformity',
    '27.2 e) Personal Emergency Evacuation Plans (PEEPs) not considered',
    'Obs: PEEPs for individuals who may have difficulty evacuating have not been considered. Rec: Complete a PEEP for each person who may need assistance (e.g. those with mobility or sensory impairments), specific to the individual and the buildings they use.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '28',
    'liaison-nominated',
    'nonConformity',
    '27.2 f) No nominated person to liaise with the fire and rescue service on arrival',
    'Obs: No person has been nominated to liaise with the fire and rescue service on arrival. Rec: Nominate a senior person with knowledge of the premises to meet the fire and rescue service and provide required information (fire location/type, occupant locations).',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '28',
    'fire-strategy',
    'select',
    '27.2 g) Is there a fire safety strategy in place supporting the fire safety arrangements?',
    'A (retrospective) fire strategy sets out the design basis of the premises in respect of fire and shows compliance with the Building Regulations - means of warning and escape, internal/external fire spread and access/facilities for the fire service.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '28',
    'disabled-assistance',
    'nonConformity',
    '27.2 h) No persons nominated to assist disabled persons during evacuation',
    'Obs: No persons have been nominated to assist disabled persons who need assistance during evacuation. Rec: Implement a "buddy system" whereby nominated persons offer support to disabled persons in an emergency evacuation.',
    { allowsPhotos: true },
  ),
]);

// --- 29 Training and Drills --------------------------------------------------
const SECTION_29 = section('29', 'Training and Drills', [
  makeQuestion(
    '29',
    'training-adequate',
    'select',
    '28.1 Are all staff given adequate fire safety instruction and training?',
    'Legislation requires appropriate fire safety training for all staff, repeated periodically and on material changes to the risk assessment.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '29',
    'induction-training',
    'nonConformity',
    '28.2 a) No fire induction training policy in place',
    'Obs: There is no fire induction training policy in place. Rec: Establish a fire induction training policy delivered to all new staff or residents.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'ongoing-training',
    'nonConformity',
    '28.2 b) No appropriate ongoing fire awareness training',
    'Obs: No appropriate ongoing fire awareness training is given. Rec: Provide adequate safety training, repeated periodically (typically every 12 months) or on a material change to the risk assessment.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'fire-marshals-nominated',
    'nonConformity',
    '28.2 c) No fire marshals nominated to assist in managing evacuation',
    'Obs: No fire marshals are nominated to assist in managing the evacuation. Rec: Nominate and train a sufficient number of fire marshals/wardens, spread across departments and locations, to manage the evacuation process.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'fire-marshals-trained',
    'nonConformity',
    '28.2 c.i) Fire marshals inadequately trained',
    'Obs: Fire marshals are not adequately trained. Rec: Provide fire marshals with more comprehensive training from a competent person, appropriate to their more active role in the fire strategy.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'drill-6-months',
    'nonConformity',
    '28.2 d) No fire drill carried out in the last 6 months',
    'Obs: No evacuation/fire drill has been carried out in the last 6 months. Rec: Carry out at least two fire drills per year and record the results.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'training-records',
    'nonConformity',
    '28.2 e) No records kept of fire safety training and/or drills',
    'Obs: No records are kept of fire safety training and/or drills. Rec: Record all staff training and drills in the fire logbook and make them available for inspection; review annually.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'contractors-familiar',
    'nonConformity',
    '28.2 f) Outside contractors not familiar with emergency procedures',
    'Obs: Outside contractors are not familiar with the procedures to be followed in an emergency. Rec: Give contractors comprehensible, relevant information on fire safety measures and evacuation arrangements.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '29',
    'disabled-strategy-training',
    'nonConformity',
    '28.2 g) Staff managing the escape strategy for disabled persons not properly trained',
    'Obs: Staff required to manage the escape strategy for disabled persons are not properly trained. Rec: All such staff should receive disability escape etiquette training in the relevant procedures.',
    { allowsPhotos: true },
  ),
]);

// --- 30 Testing and Maintenance ----------------------------------------------
const SECTION_30 = section('30', 'Testing and Maintenance', [
  makeQuestion(
    '30',
    'maintenance-adequate',
    'select',
    '29.1 Is there adequate maintenance of the premises?',
    'The Responsible Person must maintain the premises and fire safety facilities/equipment in an efficient state, in efficient working order and in good repair.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '30',
    'alarm-testing',
    'nonConformity',
    '29.2 a) Weekly testing and periodic servicing of the fire detection and alarm system not undertaken',
    'Obs: A weekly fire alarm test is not being conducted. Rec: Test the alarm weekly from a different call point each week (checking the sound and panel signal), reset the panel, and have periodic servicing to BS 5839.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '30',
    'lighting-testing',
    'nonConformity',
    '29.2 b) Monthly and annual testing routines not in place for emergency escape lighting',
    'Obs: The escape lighting is not tested in accordance with BS 5266. Rec: Inspect and maintain by a competent certificated organisation to BS 5266-8 - daily check, monthly test and annual full-duration test, all recorded in a logbook.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '30',
    'extinguisher-maintenance',
    'nonConformity',
    '29.2 c) Annual maintenance of fire extinguishing appliances not undertaken',
    'Obs: Portable extinguishers are not being serviced in line with current standards. Rec: Periodically maintain and test extinguishers to BS 5306-3 by a competent person (a basic service at least every 12 months), with records kept.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '30',
    'rising-mains-testing',
    'nonConformity',
    '29.2 d) Six-monthly inspection and annual testing of rising mains not undertaken',
    'Obs: Dry/wet risers are present but not subject to periodic testing, inspection and maintenance. Rec: Check dry mains every six months (all valves serviceable) to BS 9990, and carry out an annual wet pressure test to confirm no leakage.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '30',
    'evacuation-lift-testing',
    'nonConformity',
    '29.2 e) Testing/inspection of firefighting or evacuation lifts not undertaken',
    'Obs: Weekly/monthly testing, six-monthly inspection and annual testing of firefighting/evacuation lifts are not undertaken. Rec: Test override switches weekly, inspect monthly and carry out annual testing/maintenance; BS 9999 gives comprehensive guidance.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '30',
    'fire-door-testing',
    'nonConformity',
    '29.2 f) Fire-resisting doors not tested/inspected as part of a maintenance programme',
    'Obs: Fire doors are not being tested and maintained as part of a maintenance programme. Rec: Check fire doors at least every six months (more often for high-use or newly occupied buildings), inspecting self-closers, intumescent strips, the leaf/frame and door furniture.',
    { allowsPhotos: true },
  ),
]);

// --- 31 Records --------------------------------------------------------------
const SECTION_31 = section('31', 'Records', [
  makeQuestion(
    '31',
    'records-appropriate',
    'yesno',
    '30.1 Are there appropriate records of the testing and maintenance of fire safety measures?',
    'A fire safety logbook and maintenance record should remain on the premises and be available for inspection under the Fire Safety Order.',
  ),
  makeQuestion(
    '31',
    'alarm-records',
    'nonConformity',
    '30.2 a) No records for testing of the fire detection and alarm system',
    'Obs: The maintenance records of fire safety measures were not evident. Rec: Maintain a fire precautions logbook covering fire instruction, training, drills, and the testing, inspection and maintenance of the alarm and detection system.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '31',
    'lighting-records',
    'nonConformity',
    '30.2 b) No records for testing of the emergency escape lighting',
    'Obs: No records available for testing of the emergency escape lighting. Rec: Record all emergency lighting tests and any resulting maintenance in the fire safety logbook.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '31',
    'extinguisher-records',
    'nonConformity',
    '30.2 c) No records for testing/maintenance of extinguishing appliances',
    'Obs: No records available for testing of the extinguishing appliances. Rec: Record inspection, testing and maintenance of portable firefighting equipment and fixed installations in the fire safety logbook.',
    { allowsPhotos: true },
  ),
]);

// --- 32 Premises Information Box ---------------------------------------------
const SECTION_32 = section('32', 'Premises Information Box', [
  makeQuestion(
    '32',
    'pib-present',
    'select',
    '31.1 Is there a suitably located premises information box for the fire and rescue service?',
    'From 23 January 2023 the Fire Safety (England) Regulations 2022 require a secure information box for existing high-rise residential buildings, holding UK contact details, floor plans and a block plan identifying key firefighting equipment.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '32',
    'pib-maintenance',
    'nonConformity',
    '31.2 Arrangements to keep the premises information box up to date not adequate',
    'Obs: The arrangements to keep the premises information box up to date are not adequate. Rec: Maintain the box and keep its contents up to date, with access given to the fire and rescue service, per the regulations and the Fire Safety Order.',
    { allowsPhotos: true },
  ),
]);

// --- 33 Engagement with Residents --------------------------------------------
const SECTION_33 = section('33', 'Engagement with Residents', [
  makeQuestion(
    '33',
    'info-disseminated',
    'select',
    '32.1 Has information on fire procedures been disseminated to residents?',
    'The Building Safety Act 2022 and Fire Safety Order amendments require residents to be informed about the measures taken to keep their building safe.',
    { options: NA_YES_NO },
  ),
  makeQuestion(
    '33',
    'resident-info',
    'nonConformity',
    '32.2 a) Fire safety information disseminated to residents not adequate or not in place',
    'Obs: The fire safety information disseminated to residents is not adequate or not in place (Building Safety Act 2022). Rec: Provide residents with the risks identified, the fire safety measures provided, a UK name/address for notices, and the identity of persons appointed to assist with the assessment and firefighting measures.',
    { allowsPhotos: true },
  ),
  makeQuestion(
    '33',
    'fire-strategy-in-place',
    'nonConformity',
    '32.2 b) No fire strategy in place setting out the design of the premises in respect of fire',
    'Obs: There is no fire strategy setting out the design of the premises in respect of fire. Rec: Carry out a retrospective fire strategy covering means of warning and escape, internal/external fire spread and access/facilities for the fire service; the Principal Accountable Person must promote resident participation in safety decision-making.',
    { allowsPhotos: true },
  ),
]);

// --- 34 Fire Risk Evaluation and Assessor Summary ----------------------------
// The source form's "Fire risk (life risk) evaluation" is a risk level estimator:
// likelihood of fire against potential consequences of fire, the intersection
// giving the risk to life. It is transcribed VERBATIM from the client's document
// because this is a regulated form; the definitions below are part of the record,
// not help text.
//
// Modelled as a single `matrix` question rather than three separate selects so
// the outcome cannot contradict the two axes an assessor actually chose - the
// server can re-derive it from `cells`, which a free-choice select can never
// guarantee.
//
// WORDING: the client's grid image labels the cells "Trivial risk", "Tolerable
// risk" and so on, but the document's own tick-list and its risk-based control
// plan table use the bare names. The bare names are used here so a recorded
// outcome matches the control plan verbatim and needs no re-mapping downstream.
const LIFE_RISK_ESTIMATOR: QuestionMatrix = {
  rowLabel: 'Likelihood of fire',
  columnLabel: 'Potential consequences of fire',
  rows: ['Low', 'Medium', 'High'],
  columns: ['Slight harm', 'Moderate harm', 'Extreme harm'],
  cells: [
    ['Trivial', 'Tolerable', 'Moderate'],
    ['Tolerable', 'Moderate', 'Substantial'],
    ['Moderate', 'Substantial', 'Intolerable'],
  ],
  definitions: {
    Low: 'Unusually low likelihood of fire as a result of negligible potential sources of ignition.',
    Medium:
      'Normal fire hazards (e.g., potential ignition sources) for this type of occupancy, with fire hazards generally subject to appropriate controls (other than minor shortcomings).',
    High: 'Lack of adequate controls applied to one or more significant fire hazards, such as to result in significant increase in likelihood of fire.',
    'Slight harm':
      'Outbreak of fire unlikely to result in serious injury or death of any occupant.',
    'Moderate harm':
      'Outbreak of fire could foreseeably result in injury (including serious injury) of one or more occupants but is unlikely to result in multiple fatalities.',
    'Extreme harm':
      'Significant potential for serious injury or death of one or more occupants.',
  },
};

const SECTION_34 = section('34', 'Fire Risk Evaluation and Summary', [
  makeQuestion(
    '34',
    'risk-to-life',
    'matrix',
    'Accordingly, the risk to life from fire at these premises is considered to be:',
    'Taking into account the fire prevention measures observed at the time of this risk assessment, select the hazard from fire (likelihood of fire) at these premises. Then, considering the nature of the premises and the occupants as well as the fire protection and procedural arrangements observed, select the consequences for life safety in the event of fire. The intersection gives the risk to life. Although the purpose of this section is to place the fire risk in context, this approach to risk assessment is subjective and for guidance only. All hazards and deficiencies identified in this report should be addressed by implementing all recommendations contained in the following action plan, and the fire risk assessment should be repeated regularly.',
    { matrix: LIFE_RISK_ESTIMATOR, required: true },
  ),
  // The paper form pairs the estimator with a free-text comments box directly
  // beneath it, so it sits here rather than at the end of the section.
  makeQuestion(
    '34',
    'assessor-comments',
    'longtext',
    'Risk assessor comments',
    'Provide concluding comments on the fire risk and the priority/timescale for the recommended actions in the action plan.',
    { required: true },
  ),
  makeQuestion(
    '34',
    'target-risk-level',
    'select',
    'The action plan should reduce fire risk to, or maintain it at, the following level:',
    'A suitable risk-based control plan should involve effort and urgency proportional to the risk.',
    { options: ['Trivial', 'Tolerable'] },
  ),
]);

// --- The published template ---------------------------------------------------
export const BS9792_SECTIONS: TemplateSection[] = [
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
  SECTION_13,
  SECTION_14,
  SECTION_15,
  SECTION_16,
  SECTION_17,
  SECTION_18,
  SECTION_19,
  SECTION_20,
  SECTION_21,
  SECTION_22,
  SECTION_23,
  SECTION_24,
  SECTION_25,
  SECTION_26,
  SECTION_27,
  SECTION_28,
  SECTION_29,
  SECTION_30,
  SECTION_31,
  SECTION_32,
  SECTION_33,
  SECTION_34,
];

export const BS9792_TEMPLATE: Template = {
  name: 'BS 9792 Housing Fire Risk Assessment',
  version: BS9792_TEMPLATE_VERSION,
  status: 'published',
  standard: 'bs9792',
  sections: BS9792_SECTIONS,
};
