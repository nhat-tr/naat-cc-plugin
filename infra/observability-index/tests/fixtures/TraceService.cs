namespace Acme.Tracing
{
    public class TraceService
    {
        private readonly IActivitySourceProvider _activitySourceProvider;
        private readonly ILogger<TraceService> _logger;

        public TraceService(IActivitySourceProvider activitySourceProvider, ILogger<TraceService> logger)
        {
            _activitySourceProvider = activitySourceProvider;
            _logger = logger;
        }

        public async Task<string> RunTracedAsync(string input)
        {
            return await _activitySourceProvider.GetActivitySource().RunInActivity("TraceService.RunTracedAsync", async () =>
            {
                _logger.LogInformation("Running traced operation {Input}", input);
                return await Task.FromResult(input);
            });
        }

        public async Task HandleEventAsync(SomeEvent evt)
        {
            await _activitySourceProvider.GetActivitySource().RunInEventHandlingSpan(evt, typeof(SomeEvent).Name, async () =>
            {
                _logger.LogInformation("Handling event {EventId}", evt.Id);
            });
        }

        public async Task PublishAsync(string exchange)
        {
            await _activitySourceProvider.GetActivitySource().RunInEventPublishingSpan("my.exchange", async activity =>
            {
                _logger.LogInformation("Publishing to {Exchange}", exchange);
            });
        }

        public async Task<T> GraphQlRequestAsync<T>(string operationName, Func<Task<T>> action)
        {
            return await _activitySourceProvider.GetActivitySource()
                .RunGraphQLRequestInActivity(
                    operationName,
                    null!,
                    action
                );
        }

        public async Task<string> GetProductAsync(string id)
        {
            return await _activitySourceProvider.GetActivitySource().RunGraphQLRequestInActivity("TraceService.GetProduct", null!, () => Task.FromResult(id));
        }

        public void StartManualSpan()
        {
            using var activity = _activitySourceProvider.GetActivitySource().StartActivity("TraceService.ManualSpan");
            _logger.LogInformation("Manual span started");
        }
    }
}
