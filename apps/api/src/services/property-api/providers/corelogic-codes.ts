/**
 * CoreLogic Property Code → Label Mappings
 *
 * Maps raw CoreLogic type codes to human-readable descriptions.
 * Sources: CoreLogic RiPT Code Values (ript.corelogic.com), CoreLogic Data Dictionary.
 *
 * Building styles use 3-letter codes (COL, RAN, etc.) per official CoreLogic docs.
 * Some APIs also return numeric codes (001, 002, etc.) — both are mapped.
 */

// ─── Building Style ─────────────────────────────────────────────────────────
// Source: https://ript.corelogic.com/PCFRSWebElements/html/RiPTCodeValue.HTML

export const BUILDING_STYLE: Record<string, string> = {
  // Official 3-letter codes
  'ADC': 'Art Deco',
  'AFR': 'A-Frame',
  'ANT': 'Antique/Historic',
  'BIL': 'Bi-Level',
  'BUN': 'Bungalow',
  'CAB': 'Cabin',
  'CAP': 'Cape Cod',
  'CHL': 'Chalet/Alpine',
  'CLU': 'Cluster',
  'CNT': 'Contemporary',
  'COA': 'Coach/Carriage House',
  'COL': 'Colonial',
  'CON': 'Conventional',
  'COT': 'Cottage',
  'DES': 'Custom/Designer',
  'DOME': 'Dome',
  'END': 'End Unit',
  'EUR': 'European',
  'FED': 'Federalist',
  'FLAT': 'Flat',
  'FRE': 'French Provincial',
  'GAM': 'Gambrel/Barn',
  'GEO': 'Geodesic',
  'GOT': 'Gothic',
  'GRE': 'Greek Revival',
  'GRG': 'Georgian',
  'GRS': 'Garrison/Frontier',
  'HRI': 'High Rise',
  'HSH': 'H-Shape',
  'LOFT': 'Loft',
  'LOG': 'Log',
  'LRI': 'Low Rise',
  'LSH': 'L-Shape',
  'MAN': 'Mansion',
  'MDR': 'Modular/Prefab',
  'MED': 'Mediterranean',
  'MID': 'Middle Unit',
  'MIS': 'Mission',
  'MLL': 'Multi-Level',
  'MNF': 'Manufactured',
  'MOD': 'Modern',
  'MRI': 'Mid Rise',
  'MTL': 'Metal',
  'MWD': 'Multi-Wide',
  'NCO': 'New Construction',
  'NEN': 'New England',
  'OLD': 'Old',
  'OLE': 'Old English',
  'PAT': 'Patio-Home',
  'PNT': 'Penthouse',
  'QUA': 'Quad-Level',
  'RAN': 'Ranch',
  'REC': 'Rectangular Design',
  'RRA': 'Raised Ranch',
  'SLT': 'Salt Box',
  'SPA': 'Spanish',
  'SPF': 'Split Foyer',
  'SPL': 'Split Level',
  'SQU': 'Square Design',
  'STU': 'Studio',
  'SWD': 'Single-Wide',
  'SWN': 'Southwestern',
  'TLV': 'Tri-Level',
  'TRA': 'Traditional',
  'TUD': 'Tudor',
  'UND': 'Underground/Berm',
  'USH': 'U-Shape',
  'VIC': 'Victorian',
  'WIL': 'Williamsburg',
  'WSH': 'W-Shape',

  // Numeric codes (returned by CoreLogic property detail API)
  '001': 'Conventional',
  '002': 'Ranch',
  '003': 'Colonial',
  '004': 'Cape Cod',
  '005': 'Bungalow',
  '006': 'Victorian',
  '007': 'Split Level',
  '008': 'Bi-Level',
  '009': 'Contemporary',
  '010': 'Tudor',
}

// ─── Construction Type ───────────────────────────────────────────────────────

export const CONSTRUCTION_TYPE: Record<string, string> = {
  'FRM': 'Frame/Wood',
  'FRY': 'Frame/Wood',
  'FR0': 'Frame',
  'MSN': 'Masonry',
  'MS0': 'Masonry',
  'CBL': 'Concrete Block',
  'CB0': 'Concrete Block',
  'CNB': 'Concrete Block',
  'BRK': 'Brick',
  'BR0': 'Brick',
  'STL': 'Steel',
  'ST0': 'Steel Frame',
  'STG': 'Steel/Glass',
  'CON': 'Concrete',
  'CN0': 'Concrete',
  'LOG': 'Log',
  'LG0': 'Log',
  'MFG': 'Manufactured',
  'MF0': 'Manufactured',
  'PRE': 'Prefab',
  'PR0': 'Prefab',
  'MIX': 'Mixed',
  'MX0': 'Mixed',
  'STN': 'Stone',
  'SN0': 'Stone',
  'ADO': 'Adobe',
  'AD0': 'Adobe',
}

// ─── Foundation Type ─────────────────────────────────────────────────────────

export const FOUNDATION_TYPE: Record<string, string> = {
  // Standard CoreLogic/Melissa foundation codes → plain English
  'SLB': 'Slab',
  'SL0': 'Slab',
  'CRW': 'Crawl Space',
  'CR0': 'Crawl Space',
  'BSM': 'Basement',
  'BS0': 'Basement',
  'PIR': 'Pier',
  'PI0': 'Pier',
  'PIL': 'Pilings',
  'PL0': 'Pilings',
  'RSD': 'Raised',
  'RS0': 'Raised',
  'RAS': 'Raised',
  'CNT': 'Continuous Footing',
  'CN0': 'Continuous Footing',
  'CNF': 'Continuous Footing',
  'CNW': 'Continuous Wall',
  'MDS': 'Mud Sill',
  'MD0': 'Mud Sill',
  'MUD': 'Mud Sill',
  'FLT': 'Floating',
  'FL0': 'Floating',
  'BLK': 'Block',
  'BRK': 'Brick',
  'CNB': 'Concrete Block',
  'CRB': 'Concrete/Beam',
  'CRE': 'Concrete',
  'CRS': 'Cross Bridged/Walls',
  'DRE': 'Dirt/Earth',
  'GDB': 'Grade Beam',
  'MSN': 'Masonry',
  'PPI': 'Pipe/Iron',
  'PRE': 'Pre-Fab',
  'SDF': 'Spread Footing',
  'STD': 'Standard',
  'STE': 'Steel',
  'STM': 'Stem Wall',
  'STN': 'Stone',
  'WOO': 'Wood',
  'UBM': 'Unknown (with basement)',
  'UCR': 'Unknown (with crawl space)',
  'UPB': 'Unknown (with partial basement)',
  '000': 'None',
  '001': 'Unknown',
}

// ─── Roof Type (Shape) ───────────────────────────────────────────────────────

export const ROOF_TYPE: Record<string, string> = {
  '00M': 'Gable',
  '00N': 'Hip',
  '00O': 'Flat',
  '00P': 'Shed',
  '00Q': 'Mansard',
  '00R': 'Gambrel',
  '00S': 'A-Frame',
  'GBL': 'Gable',
  'GB0': 'Gable',
  'HIP': 'Hip',
  'HP0': 'Hip',
  'FLT': 'Flat',
  'FL0': 'Flat',
  'SHD': 'Shed',
  'SH0': 'Shed',
  'MNS': 'Mansard',
  'MN0': 'Mansard',
  'GMB': 'Gambrel',
  'GM0': 'Gambrel',
}

// ─── Roof Cover (Material) ───────────────────────────────────────────────────

export const ROOF_COVER: Record<string, string> = {
  'SHG': 'Shingle',
  'SH0': 'Shingle',
  'ASH': 'Asphalt Shingle',
  'AS0': 'Asphalt Shingle',
  'SHA': 'Architectural Shingle',
  'TIL': 'Tile',
  'TL0': 'Tile',
  'CLY': 'Clay Tile',
  'CL0': 'Clay Tile',
  'CTL': 'Concrete Tile',
  'MTL': 'Metal',
  'MT0': 'Metal',
  'SLT': 'Slate',
  'SL0': 'Slate',
  'WDS': 'Wood Shake',
  'WD0': 'Wood Shake',
  'TAR': 'Tar/Gravel',
  'TA0': 'Tar/Gravel',
  'RBR': 'Rubber',
  'RB0': 'Rubber',
  'ALM': 'Aluminum',
  'AL0': 'Aluminum',
  'CMP': 'Composition',
  'CP0': 'Composition',
}

// ─── Exterior Walls ──────────────────────────────────────────────────────────

export const EXTERIOR_WALLS: Record<string, string> = {
  'BRK': 'Brick',
  'BR0': 'Brick',
  'BVN': 'Brick Veneer',
  'BV0': 'Brick Veneer',
  'BOF': 'Brick on Frame',
  'STN': 'Stone',
  'SN0': 'Stone',
  'SNV': 'Stone Veneer',
  'STU': 'Stucco',
  'ST0': 'Stucco',
  'VNL': 'Vinyl Siding',
  'VN0': 'Vinyl Siding',
  'WDS': 'Wood Siding',
  'WD0': 'Wood Siding',
  'ALM': 'Aluminum Siding',
  'AL0': 'Aluminum Siding',
  'CNB': 'Concrete Block',
  'CB0': 'Concrete Block',
  'HDB': 'Hardboard',
  'HD0': 'Hardboard',
  'CED': 'Cedar',
  'CE0': 'Cedar',
  'LOG': 'Log',
  'LG0': 'Log',
  'FBR': 'Fiber Cement',
  'FB0': 'Fiber Cement',
  'MIX': 'Mixed',
  'MX0': 'Mixed',
  'MSN': 'Masonry',
  'MS0': 'Masonry',
}

// ─── Garage Type ─────────────────────────────────────────────────────────────

export const GARAGE_TYPE: Record<string, string> = {
  'A00': 'Attached',
  'A01': 'Attached 1-Car',
  'A02': 'Attached 2-Car',
  'A03': 'Attached 3-Car',
  'D00': 'Detached',
  'D01': 'Detached 1-Car',
  'D02': 'Detached 2-Car',
  'D03': 'Detached 3-Car',
  'B00': 'Basement Garage',
  'C00': 'Carport',
  'C01': 'Carport 1-Car',
  'C02': 'Carport 2-Car',
  'E00': 'Enclosed Carport',
  'T00': 'Tuck Under',
  'N00': 'None',
}

// ─── Heating Type ────────────────────────────────────────────────────────────

export const HEATING_TYPE: Record<string, string> = {
  'FA0': 'Forced Air',
  'FN0': 'Forced Air',
  'FAG': 'Forced Air Gas',
  'FAE': 'Forced Air Electric',
  'HW0': 'Hot Water',
  'HWR': 'Hot Water/Radiant',
  'HP0': 'Heat Pump',
  'RAD': 'Radiant',
  'RD0': 'Radiant',
  'BB0': 'Baseboard',
  'BBE': 'Baseboard Electric',
  'STM': 'Steam',
  'SM0': 'Steam',
  'GRV': 'Gravity',
  'GR0': 'Gravity',
  'FLR': 'Floor Furnace',
  'FL0': 'Floor Furnace',
  'WLL': 'Wall Furnace',
  'WL0': 'Wall Furnace',
  'SPH': 'Space Heater',
  'SP0': 'Space Heater',
  'SOL': 'Solar',
  'SO0': 'Solar',
  'GEO': 'Geothermal',
  'GE0': 'Geothermal',
  'NON': 'None',
  'NO0': 'None',
}

// ─── Cooling / Air Conditioning Type ─────────────────────────────────────────

export const COOLING_TYPE: Record<string, string> = {
  'CEN': 'Central A/C',
  'CN0': 'Central A/C',
  'AWA': 'Central A/C',
  'WAL': 'Wall Unit',
  'WL0': 'Wall Unit',
  'WND': 'Window Unit',
  'WN0': 'Window Unit',
  'EVP': 'Evaporative',
  'EV0': 'Evaporative',
  'NON': 'None',
  'NO0': 'None',
  'PKG': 'Package Unit',
  'PK0': 'Package Unit',
}

// ─── Pool Type ───────────────────────────────────────────────────────────────

export const POOL_TYPE: Record<string, string> = {
  'IGP': 'In-Ground',
  'IG0': 'In-Ground',
  'AGP': 'Above Ground',
  'AG0': 'Above Ground',
  'GUN': 'Gunite',
  'GN0': 'Gunite',
  'VNL': 'Vinyl',
  'VN0': 'Vinyl',
  'FBR': 'Fiberglass',
  'FB0': 'Fiberglass',
  'CON': 'Concrete',
  'CN0': 'Concrete',
  'JAC': 'Jacuzzi/Hot Tub',
  'JA0': 'Jacuzzi/Hot Tub',
  'KDN': 'Kidney',
  'KD0': 'Kidney',
  'NON': 'None',
  'NO0': 'None',
}

// ─── Building Quality ────────────────────────────────────────────────────────

export const BUILDING_QUALITY: Record<string, string> = {
  'QEX': 'Excellent',
  'QVG': 'Very Good',
  'QGD': 'Good',
  'QAV': 'Average',
  'QBA': 'Below Average',
  'QEC': 'Economical',
  'QLW': 'Low',
  'QFR': 'Fair',
  'QPR': 'Poor',
}

// ─── Lookup Helper ───────────────────────────────────────────────────────────

/**
 * Look up a human-readable label for a CoreLogic type code.
 * Returns the label if found, or the raw code if no mapping exists.
 */
export function lookupCode(table: Record<string, string>, code: string | null | undefined): string | undefined {
  if (!code) return undefined
  return table[code.toUpperCase()] ?? table[code] ?? code
}
