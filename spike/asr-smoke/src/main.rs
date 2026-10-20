use std::path::PathBuf;
use whisper_rs::{WhisperContext, WhisperContextParameters, FullParams, SamplingStrategy};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let model = PathBuf::from(args.next().expect("model path"));
    let wav = PathBuf::from(args.next().expect("wav path"));

    let mut reader = hound::WavReader::open(&wav)?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader.samples::<i16>()
            .map(|s| s.map(|v| v as f32 / 32768.0)).collect::<Result<_,_>>()?,
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_,_>>()?,
    };
    let mut pcm = samples;
    if spec.channels > 1 {
        pcm = pcm.chunks(spec.channels as usize).map(|c| c[0]).collect();
    }
    eprintln!("wav: {} Hz, {} ch, {:.2}s", spec.sample_rate, spec.channels, pcm.len() as f32 / spec.sample_rate as f32);

    let ctx = WhisperContext::new_with_params(model.to_str().unwrap(), WhisperContextParameters::default())?;
    let mut state = ctx.create_state()?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_token_timestamps(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let t = std::time::Instant::now();
    state.full(params, &pcm)?;
    eprintln!("inference: {:.2}s", t.elapsed().as_secs_f32());

    let n = state.full_n_segments();
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            let t0 = seg.start_timestamp() as f64 * 10.0;
            let t1 = seg.end_timestamp() as f64 * 10.0;
            let text = seg.to_str_lossy()?;
            println!("[{:>8.0}ms -> {:>8.0}ms] ntok={} nsp={:.3} {}", t0, t1, seg.n_tokens(), seg.no_speech_probability(), text.trim());
            if i == 0 {
                for k in 0..seg.n_tokens().min(8) {
                    if let Some(tok) = seg.get_token(k) {
                        let d = tok.token_data();
                        println!("   tok[{}] id={} p={:.3} t0={} t1={} {:?}", k, tok.token_id(), tok.token_probability(), d.t0, d.t1, tok.to_str_lossy().unwrap_or_default());
                    }
                }
            }
        }
    }
    Ok(())
}
