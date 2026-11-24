import { analyzeMaterials, getGroupProfile } from './analysis.js';
import { planItineraries } from './planner.js';
import {
  BookingLedger,
  assessReturnTrip,
  companionChangeImpact,
  correctionImpact,
  validateAssignment
} from './ledger.js';
import { buildGuideBrief, explainToParents } from './brief.js';
import { scheduleCompanionUnits } from './scheduler.js';
import { interpretRecord, interpretRequirement, interpretResource, interpretReply } from './interpret.js';

// High-level convenience API. These names intentionally cover the vocabulary
// used in the task narrative while the smaller modules remain available.
export function createService(materials, options = {}) {
  const analysis = analyzeMaterials(materials);
  const ledger = new BookingLedger(analysis, options);
  return {
    analysis,
    ledger,
    analyze: () => analysis,
    options: (opts = {}) => planItineraries(analysis, opts),
    plan: (opts = {}) => planItineraries(analysis, opts),
    book: input => ledger.createBooking(input),
    confirm: (...args) => ledger.confirmBooking(...args),
    receiveReply: reply => ledger.applyReply(reply),
    applyCorrection: reply => ledger.applyReply(reply),
    changeCompanions: (...args) => ledger.changeCompanions(...args),
    changeCompanionAgreement: (...args) => ledger.changeCompanions(...args),
    copyForNewTour: (...args) => ledger.copyForNewTour(...args),
    brief: (group, opts = {}) => buildGuideBrief(analysis, ledger, group, opts),
    validateAssignment,
    assessReturnTrip
  };
}

export const createTourService = createService;
export const TourSystem = createService;

export class TourAgency {
  constructor(materials, options = {}) {
    this.service = createService(materials, options);
    this.analysis = this.service.analysis;
    this.ledger = this.service.ledger;
  }
  analyze() { return this.analysis; }
  plan(options = {}) { return this.service.plan(options); }
  planGroups(options = {}) { return planGroups(this.analysis, options); }
  book(input) { return this.service.book(input); }
  confirm(...args) { return this.service.confirm(...args); }
  receiveReply(reply) { return this.service.receiveReply(reply); }
  applyCorrection(reply) { return this.service.applyCorrection(reply); }
  changeCompanions(...args) { return this.service.changeCompanions(...args); }
  changeCompanionAgreement(...args) { return this.service.changeCompanionAgreement(...args); }
  copyForNewTour(...args) { return this.service.copyForNewTour(...args); }
  brief(group, options = {}) { return this.service.brief(group, options); }
  parentExplanation(group, options = {}) { return explainToParents(this.analysis, group, options); }
}
export const TourPlanner = TourAgency;

export function assessMaterials(materials, options = {}) {
  const analysis = analyzeMaterials(materials);
  return { analysis, ...planItineraries(analysis, options) };
}
export const assess = assessMaterials;
export const planTour = assessMaterials;
export const generateOptions = assessMaterials;
export const checkItinerary = assessMaterials;
export const evaluateItinerary = assessMaterials;
export const evaluateAccessibility = assessMaterials;
export const analyzeAccessibility = assessMaterials;
export const generatePlan = createItinerary;
export const buildPlan = createItinerary;
export const analyzeTour = assessMaterials;

export function planGroups(materials, options = {}) {
  const analysis = materials?.byId ? materials : analyzeMaterials(materials);
  const groupPlans = analysis.groups.map(group => planItineraries(analysis, { ...options, groupProfile: group }));
  const sessions = analysis.resources
    .filter(r => /讲解|活动|session|talk|activity/i.test(`${r.type} ${r.text}`))
    .map(r => {
      const resourceMulti = r.claims?.some(c => c.code === 'multiple_groups_same_session');
      const link = analysis.links?.find(l => l.resourceIds.includes(r.id));
      const replyMulti = link?.replyId && analysis.byId[link.replyId]?.claims?.some(c => c.code === 'multiple_groups_same_session');
      return {
        id: r.id,
        location: r.to,
        slot: r.slot,
        capacityGroups: options.capacityGroups?.[r.id] || (resourceMulti || replyMulti ? 2 : 1)
      };
    });
  const units = analysis.groups.map(g => ({
    id: g.group,
    members: g.companionGroups.length ? [...new Set(g.companionGroups.flat())] : [g.group]
  }));
  const schedule = scheduleCompanionUnits({ units, sessions, stagger: options.stagger === true });
  return { analysis, groupPlans, schedule };
}

export function parseText(text, context = {}) {
  const row = typeof text === 'string' ? { id: context.id || 'inline', ...context, text } : text;
  if (context.kind === 'resource') return interpretResource(row);
  if (context.kind === 'reply') return interpretReply(row);
  if (context.kind === 'requirement') return interpretRequirement(row);
  // Inline text supplied to the natural-language API is normally a requirement.
  if (typeof text === 'string' && context.source === undefined && context.from === undefined) {
    return interpretRequirement(row);
  }
  return interpretRecord(row);
}
export const analyzeText = parseText;
export const parseRequirementText = (text, context = {}) => interpretRequirement({ id: 'requirement', ...context, text });
export const parseResourceText = (text, context = {}) => interpretResource({ id: 'resource', ...context, text });
export const parseReplyText = (text, context = {}) => interpretReply({ id: 'reply', ...context, text });

export function createItinerary(materials, input = {}) {
  const analysis = analyzeMaterials(materials);
  const planned = planItineraries(analysis, input);
  const selected = input.routeId
    ? planned.plans.find(p => p.id === input.routeId || p.resourceIds.join('>') === input.routeId)
    : planned.plans[0];
  if (!selected) throw new Error(`找不到路线：${input.routeId || '(any)'}`);
  const ledger = new BookingLedger(analysis);
  const booking = ledger.createBooking({
    ...input,
    plan: selected,
    group: input.group || planned.group,
    status: selected.committable && input.confirm ? 'confirmed' : 'draft'
  });
  return { analysis, planned, selected, booking, ledger };
}
export const buildItinerary = createItinerary;

export function reviseWithReply(materials, bookings, reply) {
  const analysis = analyzeMaterials(materials);
  return correctionImpact(bookings, reply, analysis);
}
export const applyClarification = reviseWithReply;

export function analyzeCompanionChange(booking, change) {
  return companionChangeImpact(booking, change);
}
export const propagateChange = analyzeCompanionChange;
export const changeCompanionAgreement = analyzeCompanionChange;

export function guideBriefFor(materials, group, options = {}) {
  const analysis = analyzeMaterials(materials);
  return buildGuideBrief(analysis, options.ledger || null, group, options);
}
export const getGuideBrief = guideBriefFor;
export const generateGuide = guideBriefFor;
export const guideForGroup = guideBriefFor;
export const generateBrief = guideBriefFor;
export const parentExplanationFor = (materials, group, options = {}) => {
  const analysis = analyzeMaterials(materials);
  return explainToParents(analysis, group, options);
};
export const explainParents = parentExplanationFor;

export function isConfirmationReusable(confirmation, context = {}) {
  if (!confirmation) return false;
  if (confirmation.reusableByNewTour === false) return false;
  if (context.newTour && confirmation.tourId !== context.tourId) return false;
  if (context.newGroup && confirmation.group !== context.group) return false;
  return confirmation.tourId === context.tourId && confirmation.group === context.group;
}

export function assertConfirmationUsable(confirmation, context = {}) {
  if (!isConfirmationReusable(confirmation, context)) {
    const error = new Error('旧确认只适用于原团次和 scope；新团或缩小后的需求必须重新确认。');
    error.code = 'CONFIRMATION_NOT_REUSABLE';
    throw error;
  }
  return true;
}

export { getGroupProfile };
