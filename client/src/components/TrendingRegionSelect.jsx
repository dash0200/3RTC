import React from 'react';
import { GLOBAL_REGION, regionName, setQuickPicksRegion, useQuickPicksRegion } from '../utils/quickPicks';

/** "Trending in: India ▾": whose YouTube trending charts the quick picks show. */
export default function TrendingRegionSelect({ className = '' }) {
  const { region, regions } = useQuickPicksRegion();
  if (!region || !regions.length) return null; // the server doesn't offer a choice
  const options = [...regions, GLOBAL_REGION];
  return (
    <label className={`qp-region ${className}`}>
      <span className="qp-region-label">Trending in</span>
      <select value={options.includes(region) ? region : GLOBAL_REGION} onChange={(e) => setQuickPicksRegion(e.target.value)} aria-label="Trending in which country">
        {options.map((code) => <option key={code} value={code}>{regionName(code)}</option>)}
      </select>
    </label>
  );
}
