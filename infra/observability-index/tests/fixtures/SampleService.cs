namespace Acme.Services.Orders
{
    public class SampleService
    {
        private readonly ILogger<SampleService> _logger;

        public SampleService(ILogger<SampleService> logger)
        {
            _logger = logger;
        }

        public async Task ProcessOrderAsync(int orderId, CancellationToken ct)
        {
            _logger.LogInformation("Processing order {OrderId}", orderId);
            _logger.LogDebug("Debug detail {OrderId} {Status}", orderId, "new");
            _logger.LogWarning("Order {OrderId} is delayed", orderId);
            _logger.LogError("Order {OrderId} failed with {ErrorCode}", orderId, 500);
        }

        public void SendUnstructured(string msg)
        {
            _logger.LogError("Unexpected error: " + msg);
        }

        public void SendInterpolated(string val)
        {
            _logger.LogInformation($"Interpolated {val} message");
        }
    }
}
