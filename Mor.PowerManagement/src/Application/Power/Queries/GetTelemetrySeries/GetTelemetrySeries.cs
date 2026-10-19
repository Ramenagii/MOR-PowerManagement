using Mor.PowerManagement.Application.Common.Interfaces;
using Mor.PowerManagement.Domain.Enums;

namespace Mor.PowerManagement.Application.Power.Queries.GetTelemetrySeries;

// Closed set of history windows (D1). An enum rather than a free from/to pair
// makes the query bounded by construction: the client cannot ask for a range
// the database would refuse to serve.
public enum TelemetryWindow
{
    Minutes15,
    Hour1,
    Hours6,
    Hours24,
    Days7,
}

public record GetTelemetrySeriesQuery : IRequest<TelemetrySeriesVm>
{
    public TelemetryWindow Window { get; init; } = TelemetryWindow.Hour1;

    public IReadOnlyList<int> OutletIds { get; init; } = Array.Empty<int>();

    // Fixed bucket ladder (D9). Every window lands on <= 168 buckets, so the
    // response size is constant no matter how far back the user looks.
    public static int GetBucketSeconds(TelemetryWindow window) => window switch
    {
        TelemetryWindow.Minutes15 => 10,     // 90 buckets
        TelemetryWindow.Hour1 => 30,         // 120 buckets
        TelemetryWindow.Hours6 => 300,       // 72 buckets
        TelemetryWindow.Hours24 => 900,      // 96 buckets
        TelemetryWindow.Days7 => 3600,       // 168 buckets
        _ => 10,
    };

    public static TimeSpan GetDuration(TelemetryWindow window) => window switch
    {
        TelemetryWindow.Minutes15 => TimeSpan.FromMinutes(15),
        TelemetryWindow.Hour1 => TimeSpan.FromHours(1),
        TelemetryWindow.Hours6 => TimeSpan.FromHours(6),
        TelemetryWindow.Hours24 => TimeSpan.FromHours(24),
        TelemetryWindow.Days7 => TimeSpan.FromDays(7),
        _ => TimeSpan.FromHours(1),
    };

    public static string GetLabel(TelemetryWindow window) => window switch
    {
        TelemetryWindow.Minutes15 => "15 minutes",
        TelemetryWindow.Hour1 => "1 hour",
        TelemetryWindow.Hours6 => "6 hours",
        TelemetryWindow.Hours24 => "24 hours",
        TelemetryWindow.Days7 => "7 days",
        _ => "1 hour",
    };

    // Wire representation. Distinct from GetLabel, which is the prose label.
    public static string ToWireValue(TelemetryWindow window) => window switch
    {
        TelemetryWindow.Minutes15 => "15m",
        TelemetryWindow.Hour1 => "1h",
        TelemetryWindow.Hours6 => "6h",
        TelemetryWindow.Hours24 => "24h",
        TelemetryWindow.Days7 => "7d",
        _ => "1h",
    };

    // Strict: the five documented tokens and nothing else. Case-insensitive so
    // "1H" is accepted; "60m", "1 hour" and "" are rejected with a 400 before
    // the request is ever dispatched (E4).
    public static bool TryParseWindow(string? value, out TelemetryWindow window)
    {
        window = TelemetryWindow.Hour1;

        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        switch (value.Trim().ToLowerInvariant())
        {
            case "15m": window = TelemetryWindow.Minutes15; return true;
            case "1h": window = TelemetryWindow.Hour1; return true;
            case "6h": window = TelemetryWindow.Hours6; return true;
            case "24h": window = TelemetryWindow.Hours24; return true;
            case "7d": window = TelemetryWindow.Days7; return true;
            default: return false;
        }
    }

    public static string ValidWindowValues => "15m, 1h, 6h, 24h, 7d";
}

public record TelemetryChannelDto(
    int OutletId,
    string Name,
    string RelayChannel,
    int RatedVoltageVolts,
    string Provenance,
    string ProvenanceNote,
    int SampleCount,
    IReadOnlyList<double?> Volts,
    IReadOnlyList<double?> Amps,
    IReadOnlyList<double?> Watts,
    IReadOnlyList<double?> PeakWatts);

public record TelemetryTotalsDto(
    IReadOnlyList<double?> Watts,
    double? EnergyKwhDelta);

public record TelemetrySeriesVm(
    DateTimeOffset From,
    DateTimeOffset To,
    string Window,
    int BucketSeconds,
    string Resolution,
    string WindowLabel,
    int BucketCount,
    int RawSampleCount,
    bool Truncated,
    string MeteringMode,
    DateTimeOffset GeneratedAt,
    DateTimeOffset? LatestSampleAt,
    IReadOnlyList<DateTimeOffset> Timestamps,
    IReadOnlyList<TelemetryChannelDto> Channels,
    TelemetryTotalsDto Totals);

public class GetTelemetrySeriesQueryValidator : AbstractValidator<GetTelemetrySeriesQuery>
{
    public GetTelemetrySeriesQueryValidator()
    {
        // RuleForEach, mirroring IngestTelemetryCommandValidator: a no-op when the
        // list is empty (the endpoint has already 400'd any explicit bad list).
        RuleForEach(x => x.OutletIds)
            .InclusiveBetween(1, 13);
    }
}

// One aggregated bucket straight out of Postgres. Not a DbSet entity: it is the
// row shape of the server-side aggregate, read through Database.SqlQuery<T>.
internal sealed record TelemetryBucketRow(
    int OutletId,
    DateTimeOffset Timestamp,
    double Voltage,
    double CurrentAmps,
    double PowerWatts,
    double EnergyKwh,
    int Id,
    int SampleCount,
    double PeakWatts,
    double MinVolts,
    double MaxVolts,
    DateTimeOffset LatestSampleAt);

public class GetTelemetrySeriesQueryHandler : IRequestHandler<GetTelemetrySeriesQuery, TelemetrySeriesVm>
{
    // ~7 days at the rig's full 5 s x 13 ch density. A guard, not a feature:
    // the fixed window ladder keeps it unreachable.
    public const int MaxRawScanRows = 3_000_000;

    // Fixed bin origin. A constant (rather than "now") is what makes buckets
    // align identically across channels and across requests, so the rig total
    // sums exactly and the chart axis does not jitter between requests (E3).
    public static readonly DateTimeOffset BinEpoch = new(2001, 1, 1, 0, 0, 0, TimeSpan.Zero);

    // Upper bound on the ids a caller may ask for, kept at the FULL rig's 13 even
    // though the bench rig has 2: ids above the bench channel count simply match
    // no rows and come back empty rather than erroring, which is the behaviour
    // that lets the same query run on both rigs without a rebuild.
    private const int MaxChannels = 13;

    private readonly IApplicationDbContext _context;

    public GetTelemetrySeriesQueryHandler(IApplicationDbContext context) => _context = context;

    public async Task<TelemetrySeriesVm> Handle(GetTelemetrySeriesQuery request, CancellationToken cancellationToken)
    {
        var bucketSeconds = GetTelemetrySeriesQuery.GetBucketSeconds(request.Window);
        var bucket = TimeSpan.FromSeconds(bucketSeconds);
        var now = DateTimeOffset.UtcNow;

        // from floored, to ceiled. Both echoed back so the client renders
        // exactly the axis the server aggregated over.
        //
        // `to` is ceiled first and the duration taken back from it. Flooring
        // `from` and ceiling `to` independently instead yields the duration plus
        // one whole extra bucket — the two edges land on opposite sides of the
        // same partial bucket — which would make every axis one point longer than
        // the documented ladder (361 buckets for 1h, not 360). Anchoring on the
        // trailing edge costs at most the oldest partial bucket and keeps the
        // newest reading, which is the one a live chart cares about.
        var alignedTo = DateBin(now, bucketSeconds) + bucket;
        var alignedFrom = alignedTo - GetTelemetrySeriesQuery.GetDuration(request.Window);
        var axisCount = (int)((alignedTo - alignedFrom).TotalSeconds / bucketSeconds);

        var ids = request.OutletIds.Count > 0 ? request.OutletIds : null;

        // ---- Read #1: channel metadata + metering mode (one round trip). The
        // metering mode is folded in as a correlated scalar subquery so the
        // handler stays at exactly two round trips (A2-4).
        var meta = await _context.Outlets
            .Where(o => ids == null || ids.Contains(o.Id))
            .OrderBy(o => o.Id)
            .Select(o => new
            {
                o.Id,
                o.Name,
                o.RelayChannel,
                o.RatedVoltageVolts,
                Mode = _context.PowerSystemConfigs.Select(c => (MeteringMode?)c.MeteringMode).FirstOrDefault(),
            })
            .ToListAsync(cancellationToken);

        // A device that never reported a metering mode reads as Unknown (E19):
        // the backend never guesses Simulated on the device's behalf.
        var meteringMode = meta.Count > 0 ? meta[0].Mode.GetValueOrDefault() : MeteringMode.Unknown;

    // ---- Read #2: the aggregated series (one round trip).
        //
        // Three deliberate deviations from a naive reading of the aggregate SQL,
        // each forced by the database:
        //   * date_bin's stride is bound as a typed `interval` PARAMETER. Postgres
        //     cannot parse INTERVAL '<parameter>' and errors with 22007.
        //   * the per-channel columns are AVG()-ed. Selecting them bare next to a
        //     GROUP BY is invalid SQL (42803).
        //   * GROUP BY 1, 2 rather than repeating the date_bin expression. Two
        //     distinct parameter references to the same expression are different
        //     parse nodes, so Postgres does not treat them as the same grouping
        //     key and rejects the query.
        var bucketInterval = TimeSpan.FromSeconds(bucketSeconds);
        var rows = await _context.Database
            .SqlQuery<TelemetryBucketRow>($"""
                WITH samples AS (
                    SELECT r."OutletId",
                           r."Timestamp" AS "SampleAt",
                           r."Voltage" AS "VoltageSum",
                           r."CurrentAmps" AS "CurrentAmpsSum",
                           r."PowerWatts" AS "PowerWattsSum",
                           1::bigint AS "SampleCount",
                           r."EnergyKwh" AS "EnergyKwh",
                           r."Id" AS "Id",
                           r."PowerWatts" AS "PeakWatts",
                           r."Voltage" AS "MinVolts",
                           r."Voltage" AS "MaxVolts",
                           r."Timestamp" AS "LatestSampleAt"
                    FROM "TelemetryReadings" r
                    WHERE r."Timestamp" >= {alignedFrom} AND r."Timestamp" < {alignedTo}

                    UNION ALL

                    SELECT h."OutletId",
                           h."BucketStart" AS "SampleAt",
                           h."VoltageSum",
                           h."CurrentAmpsSum",
                           h."PowerWattsSum",
                           h."SampleCount",
                           h."LastEnergyKwh" AS "EnergyKwh",
                           0::integer AS "Id",
                           h."PeakPowerWatts" AS "PeakWatts",
                           h."MinVoltage" AS "MinVolts",
                           h."MaxVoltage" AS "MaxVolts",
                           h."LatestSampleAt"
                    FROM "TelemetryReadingRollups" h
                    WHERE h."BucketStart" >= {alignedFrom} AND h."BucketStart" < {alignedTo}
                )
                SELECT s."OutletId",
                       date_bin({bucketInterval}, s."SampleAt", {BinEpoch}) AS "Timestamp",
                       SUM(s."VoltageSum") / SUM(s."SampleCount")::double precision AS "Voltage",
                       SUM(s."CurrentAmpsSum") / SUM(s."SampleCount")::double precision AS "CurrentAmps",
                       SUM(s."PowerWattsSum") / SUM(s."SampleCount")::double precision AS "PowerWatts",
                       MAX(s."EnergyKwh") AS "EnergyKwh",
                       MIN(s."Id") AS "Id",
                       SUM(s."SampleCount")::integer AS "SampleCount",
                       MAX(s."PeakWatts") AS "PeakWatts",
                       MIN(s."MinVolts") AS "MinVolts",
                       MAX(s."MaxVolts") AS "MaxVolts",
                       MAX(s."LatestSampleAt") AS "LatestSampleAt"
                FROM samples s
                GROUP BY 1, 2
                ORDER BY 1, 2
                """)
            .ToListAsync(cancellationToken);

        // ---- Guard (A2-4/E10): bound the rows the aggregate is allowed to scan.
        var estimatedRawRows = (long)(Math.Min(
            (alignedTo - alignedFrom).TotalSeconds,
            TimeSpan.FromHours(6).TotalSeconds)) * meta.Count;
        if (estimatedRawRows > MaxRawScanRows)
        {
            throw new InvalidOperationException(
                $"Requested window would scan an estimated {estimatedRawRows:N0} raw rows, above the {MaxRawScanRows:N0} ceiling.");
        }

        // ---- Pivot in memory. Zero extra queries (D2/A2-4).
        var axis = new Dictionary<long, int>(axisCount);
        for (var i = 0; i < axisCount; i++)
        {
            // UtcTicks on both sides of the pivot: alignedFrom is BinEpoch-based
            // (offset 0) and Postgres returns timestamptz as offset 0, but Ticks
            // silently disagrees with UtcTicks for any other offset and every row
            // would miss the axis and be dropped from sampleCount.
            axis[(alignedFrom + TimeSpan.FromSeconds((long)bucketSeconds * i)).UtcTicks] = i;
        }

        var byId = meta.ToDictionary(
            m => m.Id,
            m => new Accumulator(m.Id, m.Name, m.RelayChannel, m.RatedVoltageVolts, meteringMode, axisCount));

        var timestamps = new List<DateTimeOffset>(axisCount);
        for (var i = 0; i < axisCount; i++)
        {
            timestamps.Add(alignedFrom + TimeSpan.FromSeconds((long)bucketSeconds * i));
        }

        DateTimeOffset? latestSampleAt = null;
        double? firstEnergy = null, lastEnergy = null;
        var firstEnergyAt = DateTimeOffset.MinValue;
        var lastEnergyAt = DateTimeOffset.MinValue;

        foreach (var row in rows)
        {
            if (row.LatestSampleAt > (latestSampleAt ?? DateTimeOffset.MinValue))
            {
                latestSampleAt = row.LatestSampleAt;
            }

            // Energy is a monotonic counter, so first/last by timestamp is the
            // window delta. Tracked globally rather than per channel: the device
            // reports one energy register and copies it across channels.
            if (!axis.TryGetValue(row.Timestamp.UtcTicks, out var i))
            {
                continue;
            }

            if (firstEnergy is null || row.Timestamp < firstEnergyAt)
            {
                firstEnergy = row.EnergyKwh;
                firstEnergyAt = row.Timestamp;
            }

            if (lastEnergy is null || row.Timestamp > lastEnergyAt)
            {
                lastEnergy = row.EnergyKwh;
                lastEnergyAt = row.Timestamp;
            }

            if (!byId.TryGetValue(row.OutletId, out var acc))
            {
                continue;
            }

            // Three decimals on every per-channel electrical quantity. The rig
            // sees genuinely small branch readings now that each mains channel
            // has its own CT: a channel idling at 0.04 A is a real measurement,
            // and one decimal rendered it as 0.0 while two rendered it as 0.04.
            // Three keeps a sub-milliwatt resolution visible without pushing
            // binary float noise into the payload. Energy (kWh) is a monotonic
            // register and keeps its own precision below.
            acc.Volts[i] = Round(row.Voltage, 3);
            acc.Amps[i] = Round(row.CurrentAmps, 3);
            acc.Watts[i] = Round(row.PowerWatts, 3);
            acc.PeakWatts[i] = Round(row.PeakWatts, 3);
            acc.SampleCount += row.SampleCount;
        }

        // ---- Rig totals in memory, same pass over the selected channels (E6/E7).
        var totals = new double?[axisCount];
        for (var i = 0; i < axisCount; i++)
        {
            double sum = 0;
            var any = false;
            foreach (var acc in byId.Values)
            {
                if (acc.Watts[i] is not { } w)
                {
                    continue;
                }

                sum += w;
                any = true;
            }

            totals[i] = any ? Round(sum, 1) : null;
        }

        var channels = byId.Values
            .OrderBy(a => a.OutletId)
            .Select(a => new TelemetryChannelDto(
                a.OutletId,
                a.Name,
                a.RelayChannel,
                a.RatedVoltageVolts,
                a.Provenance,
                a.ProvenanceNote,
                a.SampleCount,
                a.Volts,
                a.Amps,
                a.Watts,
                a.PeakWatts))
            .ToList();

        return new TelemetrySeriesVm(
            alignedFrom,
            alignedTo,
            GetTelemetrySeriesQuery.ToWireValue(request.Window),
            bucketSeconds,
            $"{bucketSeconds} s buckets",
            $"Last {GetTelemetrySeriesQuery.GetLabel(request.Window)}",
            axisCount,
            channels.Sum(c => c.SampleCount),
            false,
            meteringMode.ToString(),
            now,
            latestSampleAt,
            timestamps,
            channels,
            new TelemetryTotalsDto(totals, EnergyDelta(firstEnergy, lastEnergy)));
    }

    // Provenance is a string, not an enum: the API serialises enums numerically
    // elsewhere, and string unions give the SPA free type safety (D8).
    private static string ResolveProvenance(MeteringMode mode, int ratedVolts) => mode switch
    {
        MeteringMode.Simulated => "Simulated",
        MeteringMode.Metered => Math.Abs(ratedVolts - 220) < 1 ? "Measured" : "DerivedNominal",
        MeteringMode.EstimatedFromCurrent => "EstimatedFromCurrent",
        _ => "Unknown",
    };

    // Provenance copy must track the hardware actually on the bench.
    //
    // The PZEM-004T v3.0 is RETIRED. What is fitted now is an INA226 on the
    // mains feed and an ADS1220 two-channel ADC driven over SPI, with a
    // ZMCT103C branch current sensor on EACH mains branch (CH1-CH2). So
    // per-branch current is MEASURED, not apportioned from a mains total -
    // that distinction is the whole point of the "Measured" provenance label,
    // and the earlier copy ("distributing the mains total across energized
    // channels weighted by allowance") told the operator the opposite of what
    // the hardware does.
    //
    // Both wired channels are 220 V mains branches with their own CT, so the
    // non-220 V arm below is now dead code on the bench rig: it survives only
    // so the full 13-channel rig (which has a 110 V branch and USB rails with
    // no sensor) still reads correctly when TestingRig is flipped back off.
    //
    // FUTURE 4+USB: the USB 5V rail (CH5, ratedVolts 5) uses this non-220 V
    // arm on the 4+USB rig. It is deliberately kept generic - it names "this
    // rail", not "the USB rail" - so that bump needs no string edit here, only
    // the rig spec change.
    private static string ResolveNote(MeteringMode mode, int ratedVolts) => mode switch
    {
        MeteringMode.Simulated =>
            "Synthesized on the ESP32 (SIMULATE_METERS = 1). No INA226, ADS1220 or branch current sensor is being read; these values are generated, not measured.",
        MeteringMode.Metered when Math.Abs(ratedVolts - 220) < 1 =>
            "Volts read from the INA226 on the mains feed. Current is measured on this channel's own ADS1220 SPI input via its ZMCT103C branch sensor - it is read directly, not distributed from a mains total. Power is volts x current on this channel.",
        MeteringMode.Metered =>
$"Volt is this channel's {ratedVolts} V nominal rating, not a measurement - this rail has no current sensor wired to it. Current and power are derived from the INA226 mains feed, not from a CT on this branch.",
        // Ported from master: the arm was unreachable while the ZMCT current-only
        // mode existed, so the UI showed the fallback text for a channel whose
        // volts are explicitly an estimate.
        MeteringMode.EstimatedFromCurrent =>
            $"Measured CURRENT only, from a ZMCT103C CT on the common feed. A current transformer has no voltage output, so the {ratedVolts} V shown is this channel's nominal rating and watts are ESTIMATED as V_nominal x I x an assumed power factor. Neither V nor W is individually measured - real power needs a PZEM-004T.",
        _ => "The device has not reported a metering mode yet, so this channel's provenance is unknown.",
    };

    // Floor a timestamp onto the fixed epoch's bucket grid. Bucket seconds always
    // divide a second, so second-resolution ticks are exact and no timezone or
    // DST arithmetic ever enters (E9).
    //
    // The subtraction of BinEpoch.Ticks is load-bearing, not decoration.
    // DateTimeOffset.Ticks counts from 0001-01-01; date_bin's origin is
    // BinEpoch (2001-01-01). Flooring the raw tick count and adding it *to*
    // BinEpoch therefore lands ~2025 ticks past the epoch — the year 4026 — and
    // every WHERE range built from it matches zero rows. UtcTicks, not Ticks, so
    // a non-UTC offset cannot shift the grid either.
    private static DateTimeOffset DateBin(DateTimeOffset value, int bucketSeconds)
    {
        var stride = TimeSpan.TicksPerSecond * bucketSeconds;
        var sinceEpoch = value.UtcTicks - BinEpoch.Ticks;

        return BinEpoch.AddTicks(sinceEpoch - (sinceEpoch % stride));
    }

    private static double Round(double value, int digits)
        => Math.Round(value, digits, MidpointRounding.AwayFromZero);

    private static double? EnergyDelta(double? first, double? last)
        => first is null || last is null ? null : Round(last.Value - first.Value, 4);

    // Mutable per-channel pivot buffer. The arrays start as all-null: a bucket
    // with no samples stays null and is never zero-filled, so an ESP32 outage
    // renders as a break in the line instead of a lie (D4/E2).
    private sealed class Accumulator
    {
        public Accumulator(int outletId, string name, string relayChannel, int ratedVoltageVolts, MeteringMode meteringMode, int axisCount)
        {
            OutletId = outletId;
            Name = name;
            RelayChannel = relayChannel;
            RatedVoltageVolts = ratedVoltageVolts;
            Provenance = ResolveProvenance(meteringMode, ratedVoltageVolts);
            ProvenanceNote = ResolveNote(meteringMode, ratedVoltageVolts);

            Volts = new double?[axisCount];
            Amps = new double?[axisCount];
            Watts = new double?[axisCount];
            PeakWatts = new double?[axisCount];
        }

        public int OutletId { get; }

        public string Name { get; }

        public string RelayChannel { get; }

        public int RatedVoltageVolts { get; }

        public string Provenance { get; }

        public string ProvenanceNote { get; }

        public double?[] Volts { get; }

        public double?[] Amps { get; }

        public double?[] Watts { get; }

        public double?[] PeakWatts { get; }

        public int SampleCount { get; set; }
    }
}
