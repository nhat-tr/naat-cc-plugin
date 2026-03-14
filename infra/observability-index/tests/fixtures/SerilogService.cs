namespace Acme.Infrastructure.Logging;

public class SerilogService
{
    public void DoWork(string key, int value)
    {
        Log.Information("Starting work for {Key}", key);
        Log.Warning("Value {Value} is below threshold", value);
        Serilog.Log.Error("Critical failure for {Key}: {Value}", key, value);
    }

    public void DoUnstructured(Exception ex)
    {
        Serilog.Log.Error("Unexpected error: " + ex);
        Log.Fatal("Fatal error: " + ex.Message);
    }
}
