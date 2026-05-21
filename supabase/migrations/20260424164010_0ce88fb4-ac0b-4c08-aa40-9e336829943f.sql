-- Ensure default value for monthly_extraction_limit
ALTER TABLE public.accounts 
ALTER COLUMN monthly_extraction_limit SET DEFAULT 100;

-- Update existing accounts that might have null limits to a default
UPDATE public.accounts SET monthly_extraction_limit = 100 WHERE monthly_extraction_limit IS NULL;

-- Create a function to get current usage if it doesn't exist (to simplify frontend calls)
CREATE OR REPLACE FUNCTION get_monthly_extraction_usage(p_account_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_usage INTEGER;
    v_current_month TEXT;
BEGIN
    v_current_month := to_char(CURRENT_DATE, 'YYYY-MM');
    
    SELECT COALESCE(SUM(requests_count), 0)
    INTO v_usage
    FROM public.api_usage_logs
    WHERE account_id = p_account_id 
    AND month = v_current_month
    AND endpoint = 'maps-data';
    
    RETURN v_usage;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;