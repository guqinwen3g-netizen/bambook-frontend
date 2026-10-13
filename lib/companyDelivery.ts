import { View } from '../types';

/** User-approved company V1 home. Legacy panorama belongs to the future digital display. */
export const COMPANY_HOME_VIEW = View.Cockpit;

export function normalizeCompanyView(view: unknown): View {
  if (view === View.Dashboard || view === View.UiLab || view === View.Emails || !Object.values(View).includes(view as View)) return COMPANY_HOME_VIEW;
  return view as View;
}

export function isDevelopingCompanyView(view: View): boolean {
  return view === View.Assistant || view === View.DataCenter;
}
