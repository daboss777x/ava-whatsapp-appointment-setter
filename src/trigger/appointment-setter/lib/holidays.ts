// Kenyan public holidays (business is closed; no slots are offered).
// Sunday holidays are observed on the Monday. Islamic holidays (Eid) depend on the moon
// and are gazetted shortly before; the dates below are estimates. Check and update yearly.
export const KENYA_HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-03-20": "Eid al-Fitr (estimate)",
  "2026-04-03": "Good Friday",
  "2026-04-06": "Easter Monday",
  "2026-05-01": "Labour Day",
  "2026-05-27": "Eid al-Adha (estimate)",
  "2026-06-01": "Madaraka Day",
  "2026-10-10": "Mazingira Day",
  "2026-10-20": "Mashujaa Day",
  "2026-12-12": "Jamhuri Day",
  "2026-12-25": "Christmas Day",
  "2026-12-26": "Boxing Day",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-03-10": "Eid al-Fitr (estimate)",
  "2027-03-26": "Good Friday",
  "2027-03-29": "Easter Monday",
  "2027-05-01": "Labour Day",
  "2027-05-17": "Eid al-Adha (estimate)",
  "2027-06-01": "Madaraka Day",
  "2027-10-11": "Mazingira Day (observed)",
  "2027-10-20": "Mashujaa Day",
  "2027-12-13": "Jamhuri Day (observed)",
  "2027-12-25": "Christmas Day",
  "2027-12-27": "Boxing Day (observed)",
};

export const holidayName = (ymd: string): string | undefined => KENYA_HOLIDAYS[ymd];
