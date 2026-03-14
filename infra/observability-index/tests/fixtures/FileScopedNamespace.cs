namespace Acme.FileScopedNamespace;

public class FileScopedService
{
    private readonly ILogger<FileScopedService> _logger;

    public FileScopedService(ILogger<FileScopedService> logger)
    {
        _logger = logger;
    }

    public void Execute(string correlationId)
    {
        _logger.LogInformation("Executing {CorrelationId}", correlationId);
    }
}
