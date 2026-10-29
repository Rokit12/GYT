// ISO 3166-1 alpha-2, the markets GYT works with first, then the rest alphabetically.
export const COUNTRIES: [string, string][] = [
  ["AE", "United Arab Emirates"], ["KE", "Kenya"], ["US", "United States"], ["GB", "United Kingdom"], ["FR", "France"],
  ["IT", "Italy"], ["MC", "Monaco"], ["MT", "Malta"], ["GR", "Greece"], ["ES", "Spain"], ["HR", "Croatia"], ["TR", "Türkiye"],
  ["NO", "Norway"], ["SG", "Singapore"], ["TH", "Thailand"], ["AU", "Australia"],
  ["AG", "Antigua and Barbuda"], ["BS", "Bahamas"], ["BR", "Brazil"], ["CA", "Canada"], ["KY", "Cayman Islands"], ["CN", "China"],
  ["CY", "Cyprus"], ["DK", "Denmark"], ["EG", "Egypt"], ["FI", "Finland"], ["DE", "Germany"], ["HK", "Hong Kong"], ["IN", "India"],
  ["ID", "Indonesia"], ["IE", "Ireland"], ["IL", "Israel"], ["JP", "Japan"], ["MY", "Malaysia"], ["MV", "Maldives"], ["MX", "Mexico"],
  ["MA", "Morocco"], ["NL", "Netherlands"], ["NZ", "New Zealand"], ["NG", "Nigeria"], ["OM", "Oman"], ["PT", "Portugal"],
  ["QA", "Qatar"], ["SA", "Saudi Arabia"], ["SC", "Seychelles"], ["ZA", "South Africa"], ["SE", "Sweden"], ["CH", "Switzerland"],
  ["TZ", "Tanzania"], ["UG", "Uganda"], ["VG", "British Virgin Islands"],
];
export const countryName = (c?: string | null) => COUNTRIES.find(([k]) => k === c)?.[1] ?? c ?? "";
