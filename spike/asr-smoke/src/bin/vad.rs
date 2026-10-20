use whisper_rs::{WhisperVadContext, WhisperVadContextParams, WhisperVadParams};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let vad_model = PathBuf::from(args.next().expect("vad model"));
    let wav = PathBuf::from(args.next().expect("wav"));

    let mut reader = hound::WavReader::open(&wav)?;
    let spec = reader.spec();
    let mut pcm: Vec<f32> = reader.samples::<i16>().map(|s| s.map(|v| v as f32/32768.0)).collect::<Result<_,_>>()?;
    if spec.channels > 1 { pcm = pcm.chunks(spec.channels as usize).map(|c| c[0]).collect(); }

    let mut cp = WhisperVadContextParams::default();
    cp.set_use_gpu(false);
    let mut vp = WhisperVadParams::default();
    vp.set_threshold(0.5);
    vp.set_min_silence_duration(500);

    let mut ctx = WhisperVadContext::new(vad_model.to_str().unwrap(), cp)?;
    let segs = ctx.segments_from_samples(vp, &pcm)?;
    println!("segments: {}", segs.num_segments());
    for s in segs { println!("  {:.0}ms -> {:.0}ms", s.start*10.0, s.end*10.0); }
    Ok(())
}
