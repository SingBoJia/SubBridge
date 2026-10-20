use std::path::PathBuf;
use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let model = PathBuf::from(args.next().expect("model"));
    let wav = PathBuf::from(args.next().expect("wav"));
    let threads: i32 = args.next().map(|s| s.parse().unwrap()).unwrap_or(8);

    let mut reader = hound::WavReader::open(&wav)?;
    let spec = reader.spec();
    let mut pcm: Vec<f32> = reader.samples::<i16>().map(|s| s.map(|v| v as f32/32768.0)).collect::<Result<_,_>>()?;
    if spec.channels > 1 { pcm = pcm.chunks(spec.channels as usize).map(|c| c[0]).collect(); }
    let dur = pcm.len() as f32 / spec.sample_rate as f32;

    let ctx = WhisperContext::new_with_params(model.to_str().unwrap(), WhisperContextParameters::default())?;
    let mut state = ctx.create_state()?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_n_threads(threads);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_token_timestamps(true);
    let t = std::time::Instant::now();
    state.full(params, &pcm)?;
    let el = t.elapsed().as_secs_f32();
    let n = state.full_n_segments();
    println!("threads={} audio={:.0}s infer={:.2}s speed={:.1}x segments={}", threads, dur, el, dur/el, n);
    Ok(())
}
