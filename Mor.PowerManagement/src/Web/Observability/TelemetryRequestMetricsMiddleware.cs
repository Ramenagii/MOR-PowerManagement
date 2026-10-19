using Mor.PowerManagement.Infrastructure.Observability;

namespace Mor.PowerManagement.Web.Observability;

public sealed class TelemetryRequestMetricsMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, TelemetryDatabaseMetrics metrics)
    {
        var category = TelemetryActivityCategories.FromRequestPath(context.Request.Path.Value);
        // Fixed category labels, never arbitrary paths, IDs or query strings.
        var route = TelemetryActivityCategories.Label(category);
        using var scope = TelemetryActivityScope.Begin(category, route);
        var original = context.Response.Body;
        var counter = new CountingStream(original);
        context.Response.Body = counter;
        try { await next(context); }
        finally
        {
            context.Response.Body = original;
            metrics.RecordHttpResponse(route, category, context.Response.StatusCode,
                counter.BytesWritten, scope.DatabaseCommands, scope.EstimatedResultBytes);
        }
    }

    private sealed class CountingStream(Stream inner) : Stream
    {
        public long BytesWritten { get; private set; }
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => inner.CanWrite;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() => inner.Flush();
        public override Task FlushAsync(CancellationToken t) => inner.FlushAsync(t);
        public override int Read(byte[] b, int o, int n) => inner.Read(b,o,n);
        public override long Seek(long o, SeekOrigin origin) => inner.Seek(o,origin);
        public override void SetLength(long n) => inner.SetLength(n);
        public override void Write(byte[] b,int o,int n) { inner.Write(b,o,n); BytesWritten += n; }
        public override void Write(ReadOnlySpan<byte> b) { inner.Write(b); BytesWritten += b.Length; }
        public override async Task WriteAsync(byte[] b,int o,int n,CancellationToken t) { await inner.WriteAsync(b,o,n,t); BytesWritten += n; }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> b,CancellationToken t = default) { await inner.WriteAsync(b,t); BytesWritten += b.Length; }
    }
}
