function hasPcttReservoirValue(reservoir) {
  if (!reservoir) return false;

  return (
    reservoir.waterLevel !== null ||
    reservoir.inflow !== null ||
    reservoir.turbineFlow !== null ||
    reservoir.spillwayFlow !== null
  );
}

function pcttReservoirSignature(reservoir) {
  if (!reservoir) return "null|null|null|null";

  return [
    reservoir.waterLevel ?? "null",
    reservoir.inflow ?? "null",
    reservoir.turbineFlow ?? "null",
    reservoir.spillwayFlow ?? "null",
  ].join("|");
}

function buildPcttDuplicateStatsByPlant(rowsRaw) {
  const plantMap = new Map();

  for (const row of rowsRaw || []) {
    const time = row?.time || null;
    if (!time) continue;

    for (const reservoir of row.reservoirs || []) {
      if (!reservoir || !hasPcttReservoirValue(reservoir)) continue;

      const plantId = reservoir.id;
      const plantKey = String(plantId);

      if (!plantMap.has(plantKey)) {
        plantMap.set(plantKey, {
          id: reservoir.id,
          name: reservoir.name,
          shortName: reservoir.shortName,
          rawRows: 0,
          timeMap: new Map(),
        });
      }

      const plant = plantMap.get(plantKey);
      plant.rawRows += 1;

      if (!plant.timeMap.has(time)) {
        plant.timeMap.set(time, new Map());
      }

      const sigMap = plant.timeMap.get(time);
      const signature = pcttReservoirSignature(reservoir);
      sigMap.set(signature, (sigMap.get(signature) || 0) + 1);
    }
  }

  const stats = Array.from(plantMap.values())
    .map(plant => {
      let duplicateRows = 0;
      let duplicateTimestamps = 0;
      let uniqueRows = 0;
      let maxDuplicateAtOneTime = 0;

      for (const [, sigMap] of plant.timeMap.entries()) {
        let timeUniqueCount = 0;
        let timeDuplicateCount = 0;

        for (const [, count] of sigMap.entries()) {
          timeUniqueCount += 1;
          if (count > 1) {
            timeDuplicateCount += count - 1;
            if (count - 1 > maxDuplicateAtOneTime) {
              maxDuplicateAtOneTime = count - 1;
            }
          }
        }

        uniqueRows += timeUniqueCount;
        duplicateRows += timeDuplicateCount;

        if (timeDuplicateCount > 0) {
          duplicateTimestamps += 1;
        }
      }

      return {
        id: plant.id,
        name: plant.name,
        shortName: plant.shortName,
        rawRows: plant.rawRows,
        uniqueRows,
        duplicateRows,
        duplicateTimestamps,
        maxDuplicateAtOneTime,
      };
    })
    .sort((a, b) => a.id - b.id);

  const summary = {
    rawRows: stats.reduce((s, x) => s + x.rawRows, 0),
    uniqueRows: stats.reduce((s, x) => s + x.uniqueRows, 0),
    duplicateRows: stats.reduce((s, x) => s + x.duplicateRows, 0),
    plantsWithDuplicates: stats.filter(x => x.duplicateRows > 0).length,
  };

  return {
    stats,
    summary,
  };
}
