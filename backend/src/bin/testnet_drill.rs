use std::{path::PathBuf, process::ExitCode};

use fyxtez_backend::testnet_drill::{DrillConfig, run};

fn usage() {
    eprintln!(
        "Usage:\n  fyxtez-testnet-drill [--symbol BTCUSDT] [--soak-seconds N] [--report PATH]\n  fyxtez-testnet-drill --execute --confirm-testnet-mutations [options]\n\nWithout --execute the command performs a read-only connectivity and safety preflight.\nMutating drills are hard-blocked unless stored desktop credentials select Testnet."
    );
}

fn parse_args() -> Result<DrillConfig, String> {
    let mut config = DrillConfig::default();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--execute" => config.execute = true,
            "--confirm-testnet-mutations" => config.confirm_testnet_mutations = true,
            "--symbol" => {
                config.symbol = args
                    .next()
                    .ok_or_else(|| "--symbol requires a value".to_owned())?;
            }
            "--soak-seconds" => {
                config.soak_seconds = args
                    .next()
                    .ok_or_else(|| "--soak-seconds requires a value".to_owned())?
                    .parse::<u64>()
                    .map_err(|_| "--soak-seconds must be a non-negative integer".to_owned())?;
            }
            "--report" => {
                config.report_path = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--report requires a path".to_owned())?,
                ));
            }
            "-h" | "--help" => {
                usage();
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }

    Ok(config)
}

#[tokio::main]
async fn main() -> ExitCode {
    let config = match parse_args() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Error: {error}");
            usage();
            return ExitCode::from(2);
        }
    };

    fyxtez_backend::init_tracing();
    match run(config).await {
        Ok(report) => {
            println!("{report}");
            if report.passed() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("Testnet drill could not start: {error}");
            ExitCode::FAILURE
        }
    }
}
